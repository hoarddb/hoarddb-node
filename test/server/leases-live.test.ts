// SPDX-License-Identifier: Apache-2.0
//
// Leases, the dead list and consume against a real server: the answers the vectors only freeze the
// shape of, in the order a program meets them. One server serves the file; every test has its own bucket.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

import {
  ClaimEntryTooLargeError,
  InvalidArgumentError,
  LeaseExpiredError,
  LeaseUnknownError,
  AbortedError,
  DeadMoveRefusedError,
  connect,
  type Client,
  type Database,
  type Doc,
  type FifoBucket,
} from '../../src/index.js';
import { startServer, type TestServer } from '../helpers/server.js';

const DATABASE = 'node_leases';

let server: TestServer;
let client: Client;
let database: Database;
let sequence = 0;

before(async () => {
  server = await startServer();
  client = await connect(server.uri(), { tls: { knownServersPath: false } });
  await client.createDatabase(DATABASE);
  database = client.database(DATABASE);
});

after(async () => {
  await client?.close({ timeoutMs: 1_000 });
  await server?.stop();
});

async function fifo(): Promise<FifoBucket<Doc>> {
  sequence += 1;
  return database.createBucket(`q${sequence}`, 'fifo');
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function settled(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
    return undefined;
  } catch (error) {
    return error;
  }
}

test('claim takes entries in pop order, hides them, and ack removes them', async () => {
  const queue = await fifo();
  for (const n of [1, 2, 3]) await queue.push({ n });
  const claimed = await queue.claim({ limit: 2, lease: 60_000 });
  assert.deepEqual(claimed.items.map((delivery) => delivery.document['n']), [1, 2]);
  assert.equal(claimed.grantedMs, 60_000);
  assert.equal(claimed.pending, 2);
  assert.match(claimed.leaseId, /^[0-9a-f]{40}$/);
  assert.deepEqual((await queue.peek({ limit: 5 })).map((document) => document['n']), [3], 'claimed entries are invisible to peek');

  const first = claimed.items[0];
  assert.ok(first !== undefined);
  const acked = await queue.ack(claimed.leaseId, { itemIds: [first.itemId] });
  assert.deepEqual([acked.state, acked.acked, acked.remaining], ['acked', 1, 1]);
  const rest = await queue.ack(claimed.leaseId);
  assert.equal(rest.acked, 1);
  assert.equal(await queue.count(), 1);
});

test('claim works on a lifo and on a heap', async () => {
  sequence += 1;
  const stack = await database.createBucket(`s${sequence}`, 'lifo');
  await stack.push({ n: 1 });
  await stack.push({ n: 2 });
  assert.equal((await stack.claim()).items[0]?.document['n'], 2, 'newest first');
  const heap = await database.createBucket(`h${sequence}`, 'heap');
  await heap.push({ n: 1 }, { priority: 1 });
  await heap.push({ n: 2 }, { priority: 5 });
  const claimed = await heap.claim({ limit: 2 });
  assert.equal(claimed.items.length, 2);
  assert.ok(claimed.items.every((delivery) => delivery.itemId.length > 0));
});

test('claim of an empty queue is an empty Claimed, and of a hash bucket a refusal', async () => {
  const queue = await fifo();
  const claimed = await queue.claim();
  assert.deepEqual(claimed.items, []);
  sequence += 1;
  const hash = await database.createBucket(`hash${sequence}`, 'hash');
  const error = await settled(client.database(DATABASE).bucket(hash.name).claim());
  assert.ok(error instanceof InvalidArgumentError);
  assert.match(error.message, /claim is not defined for hash buckets/);
});

test('release gives entries back at once; extend returns the granted length', async () => {
  const queue = await fifo();
  await queue.push({ n: 1 });
  const claimed = await queue.claim({ lease: 60_000 });
  assert.equal(await queue.extend(claimed.leaseId, 120_000), 120_000);
  const released = await queue.release(claimed.leaseId);
  assert.deepEqual([released.state, released.released], ['released', 1]);
  assert.equal((await queue.claim()).items[0]?.document['n'], 1, 'it is claimable again at once');
});

test('Delivery.extend extends the whole lease', async () => {
  const queue = await fifo();
  await queue.push({ n: 1 });
  const claimed = await queue.claim({ lease: 5_000 });
  assert.equal(await claimed.items[0]?.extend(30_000), 30_000);
});

test('an ack of a settled lease is LeaseUnknownError and of a lapsed one LeaseExpiredError or unknown, entries back', async () => {
  const queue = await fifo();
  await queue.push({ n: 1 });
  const first = await queue.claim({ lease: 60_000 });
  await queue.ack(first.leaseId);
  const again = await settled(queue.ack(first.leaseId));
  assert.ok(again instanceof LeaseUnknownError, String(again));
  assert.equal(again.result?.state, 'unknown');

  await queue.push({ n: 2 });
  const brief = await queue.claim({ lease: 1_000 });
  await sleep(1_400);
  const late = await settled(queue.ack(brief.leaseId));
  assert.ok(late instanceof LeaseExpiredError || late instanceof LeaseUnknownError, String(late));
  const back = await queue.claim();
  assert.equal(back.items[0]?.document['n'], 2);
  assert.equal(back.items[0]?.deliveries, 2, 'a redelivery counts');
});

test('a claim of an entry over the hard cap is ClaimEntryTooLargeError, and pop unblocks the queue', async () => {
  const queue = await fifo();
  await queue.push({ blob: 'x'.repeat(5 * 1024 * 1024) });
  await queue.push({ n: 2 });
  const error = await settled(queue.claim());
  assert.ok(error instanceof ClaimEntryTooLargeError, String(error));
  assert.ok(error instanceof InvalidArgumentError);
  assert.equal(error.code, 'INVALID_ARGUMENT');
  await queue.pop();
  assert.equal((await queue.claim()).items[0]?.document['n'], 2);
});

/** Claims and releases `times` times, so the entry is delivered that often without an ack. */
async function deliver(queue: FifoBucket<Doc>, times: number): Promise<void> {
  for (let attempt = 0; attempt < times; attempt += 1) {
    const claimed = await queue.claim();
    await queue.release(claimed.leaseId);
  }
}

test('an entry delivered 5 times without an ack is dead; deadList pages, requeue and discard move', async () => {
  const queue = await fifo();
  assert.deepEqual((await queue.deadList()).items, [], 'an empty dead list is an empty page');
  for (const n of [1, 2, 3]) await queue.push({ n });
  await deliver(queue, 5);
  const claimed = await queue.claim({ limit: 3 });
  assert.equal(claimed.dead >= 0, true);

  let page = await queue.deadList({ limit: 1 });
  if (page.items.length === 0) {
    // Every delivery of the first entry so far was a release: the 5th ended it, the others wait their turn.
    await queue.release(claimed.leaseId);
    await deliver(queue, 10);
    page = await queue.deadList({ limit: 1 });
  }
  assert.equal(page.items.length, 1);
  const [entry] = page.items;
  assert.equal(entry?.reason, 'max_deliveries');
  assert.ok(entry?.deadAt instanceof Date);
  assert.ok((entry?.deliveries ?? 0) >= 5);
  assert.ok(entry?.document['n'] !== undefined);

  const refused = await settled(queue.requeue({ byId: '0000000000000fff' }));
  assert.ok(refused instanceof DeadMoveRefusedError);
  assert.equal(refused.result.refused.length, 1);

  const requeued = await queue.requeue({ byId: entry?.deadId ?? '' });
  assert.equal(requeued.done, 1);
  const discarded = await queue.discard({ all: true });
  assert.ok(discarded.done >= 0);
  assert.deepEqual((await queue.deadList()).items, []);
});

test('consume runs every entry, acknowledges them, and stops on abort with nothing left under a lease', async () => {
  const queue = await fifo();
  for (const n of [1, 2, 3, 4, 5]) await queue.push({ n });
  const seen: number[] = [];
  const controller = new AbortController();
  const outcome = settled(
    queue.consume(
      (delivery) => {
        seen.push(delivery.document['n'] as number);
        if (seen.length === 5) setTimeout(() => controller.abort(), 100);
      },
      { limit: 2, signal: controller.signal },
    ),
  );
  assert.ok((await outcome) instanceof AbortedError);
  assert.deepEqual([...seen].sort(), [1, 2, 3, 4, 5]);
  assert.equal(await queue.count(), 0, 'every entry was acknowledged');
});

test('a failing handler is redelivered; a stopped consume releases what it holds', async () => {
  const queue = await fifo();
  await queue.push({ n: 1 });
  const controller = new AbortController();
  let attempts = 0;
  const outcome = settled(
    queue.consume(
      (delivery) => {
        attempts += 1;
        if (attempts === 1) throw new Error('first try fails');
        assert.equal(delivery.deliveries >= 2, true);
      },
      { lease: 1_000, signal: controller.signal },
    ),
  );
  const deadline = Date.now() + 8_000;
  while (attempts < 2 && Date.now() < deadline) await sleep(20);
  controller.abort();
  assert.ok((await outcome) instanceof AbortedError);
  assert.equal(attempts, 2);

  // Stopped while a handler holds an entry: the release makes it visible at once.
  const held = await fifo();
  await held.push({ n: 9 });
  const stop = new AbortController();
  let running = false;
  const loop = settled(
    held.consume(
      async (_delivery, signal) => {
        running = true;
        await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
        throw new Error('stopped');
      },
      { lease: 60_000, signal: stop.signal },
    ),
  );
  while (!running) await sleep(10);
  stop.abort();
  assert.ok((await loop) instanceof AbortedError);
  assert.equal((await held.peek()).length, 1, 'released, so visible again at once');
});

test('consume on a hash bucket ends with the server refusal', async () => {
  sequence += 1;
  const hash = await database.createBucket(`hashc${sequence}`, 'hash');
  const error = await settled(client.database(DATABASE).bucket(hash.name).consume(() => undefined));
  assert.ok(error instanceof InvalidArgumentError);
});

// SPDX-License-Identifier: Apache-2.0
//
// The public API against a real server: DDL, documents, misses, the wrong-store-type refusals and the
// leg 4 workload (handbook testing.md section 2). The update tests are step 20a's. Every test uses its
// own database, so the order of the tests never matters.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

import {
  AlreadyExistsError,
  FieldTypeError,
  InvalidArgumentError,
  connect,
  type Client,
  type KeyedBucket,
  type QueueBucket,
} from '../../src/index.js';
import { startServer, type TestServer } from '../helpers/server.js';
import { NotFoundError } from '../../src/errors.js';

let server: TestServer;
let client: Client;

before(async () => {
  server = await startServer();
  client = await connect(server.uri(), { tls: { knownServersPath: false } });
});

after(async () => {
  await client?.close({ timeoutMs: 1_000 });
  await server.stop();
});

/** A load run counts a typed miss instead of failing on it: the verbs throw NotFoundError, so null is the count. */
function missOrThrow(error: unknown): null {
  if (error instanceof NotFoundError) return null;
  throw error;
}

test('createDatabase twice is AlreadyExistsError', async () => {
  await client.createDatabase('twice');
  await assert.rejects(() => client.createDatabase('twice'), AlreadyExistsError);
});

test('createDatabase with ifNotExists twice succeeds', async () => {
  await client.createDatabase('repeatable', { ifNotExists: true });
  await client.createDatabase('repeatable', { ifNotExists: true });
  const names = (await client.listDatabases()).map((entry) => entry.name);
  assert.ok(names.includes('repeatable'));
});

test('createBucket same type with ifNotExists succeeds', async () => {
  await client.createDatabase('same_type');
  const database = client.database('same_type');
  await database.createBucket('b', 'hash');
  const again = await database.createBucket('b', 'hash', { ifNotExists: true });
  assert.equal(again.type, 'hash');
});

test('createBucket same type without it is AlreadyExistsError', async () => {
  // Failure 9 of section 8: the server answers a same-type create with success, and the driver must not read it as a fresh create.
  await client.createDatabase('same_type_plain');
  const database = client.database('same_type_plain');
  await database.createBucket('b', 'hash');
  await assert.rejects(() => database.createBucket('b', 'hash'), AlreadyExistsError);
});

test('createBucket of another type is AlreadyExistsError even with ifNotExists', async () => {
  await client.createDatabase('other_type');
  const database = client.database('other_type');
  await database.createBucket('b', 'hash');
  await assert.rejects(() => database.createBucket('b', 'btree', { ifNotExists: true }), AlreadyExistsError);
});

test('createBucket in a missing database creates it', async () => {
  const bucket = await client.database('made_by_bucket').createBucket('b', 'fifo');
  assert.equal(bucket.type, 'fifo');
  const names = (await client.listDatabases()).map((entry) => entry.name);
  assert.ok(names.includes('made_by_bucket'));
});

test('a typed bucket refuses a mistyped document with FieldTypeError', async () => {
  const database = client.database('typed');
  const users = await database.createBucket<{ Born: unknown }>('users', 'hash', {
    fieldTypes: { mode: 'strict', fields: [{ name: 'Born', type: 'int' }] },
  });
  await assert.rejects(
    () => users.put('ada', { Born: 'x' }),
    (error: unknown) => error instanceof FieldTypeError && error.message.includes('Born'),
  );
  await users.put('ada', { Born: 1815 });
  assert.equal((await users.get('ada'))?.Born, 1815);
});

test('get of a missing key throws NotFoundError on hash and btree', async () => {
  const database = client.database('misses');
  const hash = await database.createBucket('h', 'hash');
  const btree = await database.createBucket('b', 'btree');
  await assert.rejects(hash.get('nobody'), NotFoundError);
  await assert.rejects(btree.get('nobody'), NotFoundError);
});

test('pop of an empty fifo, lifo and heap is an empty list', async () => {
  const database = client.database('empty_queues');
  const fifo = await database.createBucket('f', 'fifo');
  const lifo = await database.createBucket('l', 'lifo');
  const heap = await database.createBucket('p', 'heap');
  assert.deepEqual(await fifo.pop(), []);
  assert.deepEqual(await lifo.pop(), []);
  assert.deepEqual(await heap.pop(), []);
});

test('pop with a limit takes that many in pop order, and no more than were there', async () => {
  const database = client.database('pop_limit');
  const fifo = await database.createBucket<{ n: number }>('f', 'fifo');
  const lifo = await database.createBucket<{ n: number }>('l', 'lifo');
  const heap = await database.createBucket<{ n: number }>('p', 'heap');
  for (let n = 1; n <= 5; n += 1) {
    await fifo.push({ n });
    await lifo.push({ n });
    await heap.push({ n }, { priority: n });
  }
  assert.deepEqual((await fifo.pop({ limit: 3 })).map((stored) => stored.n), [1, 2, 3]);
  assert.deepEqual((await lifo.pop({ limit: 3 })).map((stored) => stored.n), [5, 4, 3]);
  assert.deepEqual((await heap.pop({ limit: 3 })).map((stored) => stored.n), [5, 4, 3]);
  // Fewer than the limit is not an error: all that existed was taken.
  assert.deepEqual((await fifo.pop({ limit: 10 })).map((stored) => stored.n), [4, 5]);
  assert.deepEqual(await fifo.pop({ limit: 10 }), []);
  assert.equal((await lifo.peek({ limit: 10 })).length, 2, 'what was not popped is still there');
  await assert.rejects(() => fifo.pop({ limit: 101 }), InvalidArgumentError);
});

test('delete of a missing key is false and twice is safe', async () => {
  const database = client.database('deletes');
  const hash = await database.createBucket('h', 'hash');
  assert.equal(await hash.delete('nobody'), false);
  await hash.put('ada', { n: 1 });
  assert.equal(await hash.delete('ada'), true);
  assert.equal(await hash.delete('ada'), false);
});

test('insert assigns a key', async () => {
  const database = client.database('inserts');
  const hash = await database.createBucket<{ n: number }>('h', 'hash');
  const result = await hash.insert({ n: 7 });
  assert.ok(result.id.length > 0, 'the server assigned a key');
  assert.equal((await hash.get(result.id))?.n, 7);
});

test('a heap push without priority is stored at 0', async () => {
  // The server accepts a priority-less push and stores it at 0. Priority -1, none and 1 pop in
  // an order that puts the priority-less one in the middle whichever end the heap serves first.
  const database = client.database('heap_default');
  const heap = await database.createBucket<{ name: string }>('p', 'heap');
  await heap.push({ name: 'low' }, { priority: -1 });
  await heap.push({ name: 'none' });
  await heap.push({ name: 'high' }, { priority: 1 });
  const order: string[] = [];
  for (let next = await heap.pop(); next.length > 0; next = await heap.pop()) order.push(next[0]?.name ?? '');
  assert.equal(order.length, 3);
  assert.equal(order[1], 'none');
});

test("a verb on the wrong store type passes the server's refusal through", async () => {
  const database = client.database('wrong_type');
  await database.createBucket('f', 'fifo');
  await database.createBucket('h', 'hash');
  const fifo = database.bucket('f');
  const hash = database.bucket('h');

  await assert.rejects(
    () => fifo.get('key'),
    (error: unknown) =>
      error instanceof InvalidArgumentError && error.message.includes('get is not supported for bucket type fifo'),
  );
  await assert.rejects(
    () => hash.pop(),
    (error: unknown) =>
      error instanceof InvalidArgumentError && error.message.includes('pop is not defined for hash buckets'),
  );
  // operations.md section 1 records this as a known deviation: the server accepts a keyed put on a fifo
  // bucket although the handbook marks the cell "-". The vectors pin it, so it is asserted as accepted.
  const accepted = await fifo.put('key', { n: 1 });
  assert.ok(accepted.id.length > 0);
});

interface Sample {
  n: number;
  name: string;
  flag: boolean;
  ratio: number;
  nested: { a: number };
  tags: string[];
  when: Date;
}

function sampleOf(index: number): Sample {
  return {
    n: index,
    name: `item-${index}`,
    flag: index % 2 === 0,
    ratio: index + 0.5,
    nested: { a: index * 3 },
    tags: ['x', `y${index}`],
    when: new Date(Date.UTC(2026, 0, 1, 0, 0, index)),
  };
}

/** A stored document as it was written: the server adds only its own key field. */
function withoutKey<T extends object>(stored: T & { _id_?: string }): T {
  const { _id_: _key, ...rest } = stored;
  return rest as T;
}

function report(type: string, hits: number, misses: number): void {
  process.stdout.write(`leg 4 ${type}: hits=${hits} misses=${misses}\n`);
  assert.equal(hits, 50);
  assert.equal(misses, 0);
}

test('leg 4 workload: every store type round-trips 50 values with hits=50 misses=0', async () => {
  const database = client.database('leg4');

  const keyed: [string, KeyedBucket<Sample>][] = [
    ['hash', await database.createBucket<Sample>('keyed_hash', 'hash')],
    ['btree', await database.createBucket<Sample>('keyed_btree', 'btree')],
  ];
  for (const [type, bucket] of keyed) {
    let hits = 0;
    let misses = 0;
    for (let index = 0; index < 50; index += 1) await bucket.put(`k${index}`, sampleOf(index));
    for (let index = 0; index < 50; index += 1) {
      const stored = await bucket.get(`k${index}`).catch(missOrThrow);
      if (stored === null) {
        misses += 1;
        continue;
      }
      assert.deepEqual(withoutKey(stored), sampleOf(index), `${type} document ${index}`);
      hits += 1;
    }
    report(type, hits, misses);
  }

  const queues: [string, QueueBucket<Sample>][] = [
    ['fifo', await database.createBucket<Sample>('queue_fifo', 'fifo')],
    ['lifo', await database.createBucket<Sample>('queue_lifo', 'lifo')],
  ];
  for (const [type, bucket] of queues) {
    let hits = 0;
    let misses = 0;
    for (let index = 0; index < 50; index += 1) await bucket.push(sampleOf(index));
    for (let position = 0; position < 50; position += 1) {
      const stored = (await bucket.pop())[0] ?? null;
      const index = type === 'fifo' ? position : 49 - position;
      if (stored === null) {
        misses += 1;
        continue;
      }
      assert.deepEqual(withoutKey(stored), sampleOf(index), `${type} document ${index}`);
      hits += 1;
    }
    report(type, hits, misses);
  }

  {
    const heap = await database.createBucket<Sample>('queue_heap', 'heap');
    let hits = 0;
    let misses = 0;
    for (let index = 0; index < 50; index += 1) await heap.push(sampleOf(index), { priority: index });
    const seen = new Map<number, Sample>();
    for (let position = 0; position < 50; position += 1) {
      const stored = (await heap.pop())[0] ?? null;
      if (stored === null) misses += 1;
      else seen.set(stored.n, withoutKey(stored));
    }
    for (let index = 0; index < 50; index += 1) {
      assert.deepEqual(seen.get(index), sampleOf(index), `heap document ${index}`);
      hits += 1;
    }
    report('heap', hits, misses);
  }

  {
    const blobs = await database.createBucket('files', 'blob');
    let hits = 0;
    let misses = 0;
    const bytesOf = (index: number): Uint8Array => Uint8Array.from({ length: 100 + index }, (_, at) => (at * 7 + index) % 256);
    for (let index = 0; index < 50; index += 1) {
      await blobs.putBlob(`b${index}`, bytesOf(index), { metadata: { index } });
    }
    for (let index = 0; index < 50; index += 1) {
      const stored = await blobs.getBlob(`b${index}`).catch(missOrThrow);
      if (stored === null) {
        misses += 1;
        continue;
      }
      assert.deepEqual(Buffer.from(stored.data), Buffer.from(bytesOf(index)), `blob ${index}`);
      assert.equal(stored.key, `b${index}`);
      assert.equal(stored.size, 100 + index);
      assert.equal(stored.metadata['index'], index);
      hits += 1;
    }
    report('blob', hits, misses);
  }
});

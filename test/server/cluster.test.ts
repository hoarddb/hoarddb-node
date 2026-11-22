// SPDX-License-Identifier: Apache-2.0
//
// Three real nodes (handbook testing.md section 3.2): the cluster vectors replayed, and leg 9, the
// write concern against a ring. One cluster, with a fourth node that was never joined, serves the
// whole file; the tests that stop a node bring it back, so their order does not matter.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { InvalidArgumentError, UnavailableError, connect, type Client, type WriteConcern } from '../../src/index.js';
import { startCluster, type TestCluster } from '../helpers/cluster.js';
import { replayExchange, type TestServer } from '../helpers/server.js';
import { loadDriverVectors, type Vector } from '../helpers/vectors.js';

const TRUST = { knownServersPath: false } as const;

let cluster: TestCluster;
let client: Client;

before(async () => {
  cluster = await startCluster();
  const [first] = cluster.nodes;
  assert.ok(first !== undefined);
  client = await connect(first.uri(), { tls: TRUST });
});

after(async () => {
  await client?.close({ timeoutMs: 1_000 });
  await cluster?.stop();
});

test('leg 3 replay (cluster3)', async () => {
  // The vectors run in file order on one cluster, because an answer depends on what ran before it (a
  // "bucket info" counts the copies in sync; testing.md section 1.1 says its notes name the earlier
  // vector that stopped a node). A row that is not replayed (replay: false) still happened at capture,
  // so its notes' node changes are applied when the walk reaches it.
  const rows = loadDriverVectors().vectors.filter((vector) => vector.kind === 'exchange' && vector['topology'] === 'cluster3');
  const exchanges = rows.filter((vector) => vector['replay'] === true);
  const [node1] = cluster.nodes;
  assert.ok(node1 !== undefined);

  let passed = 0;
  const failures: string[] = [];
  const replay = async (vector: Vector, target: TestServer, pairs?: ReturnType<TestCluster['identity']>): Promise<void> => {
    try {
      await replayExchange(vector, target, pairs);
      passed += 1;
    } catch (error) {
      failures.push((error as Error).message);
    }
  };

  // Each listing takes its fixed fingerprints from the other, so neither validates itself (N-59).
  const identities: Record<string, string> = {
    health: 'list nodes',
    'list nodes': 'list nodes with membership history',
    'list nodes with membership history': 'list nodes',
  };
  const stopped = new Set<number>();
  let newcomer: TestServer | undefined;
  try {
    for (const vector of rows) {
      const notes = String(vector['notes'] ?? '');
      if (vector['replay'] !== true) {
        // The row's own request is not sent; what it did to the cluster is.
        for (const index of nodesNamed(notes, /node(\d+) is stopped after the setup/g)) {
          await cluster.stopNode(index);
          stopped.add(index);
        }
        for (const index of nodesNamed(notes, /node(\d+) is started again first/g)) {
          if (stopped.delete(index)) await cluster.startNode(index);
        }
        continue;
      }
      if (vector.name.includes('not yet added')) {
        newcomer ??= await cluster.startNewcomer();
        await replay(vector, newcomer);
        continue;
      }
      // The history listing names the newcomer's epoch, so the newcomer runs before it.
      if (vector.name === 'list nodes with membership history') newcomer ??= await cluster.startNewcomer();
      const pair = identities[vector.name];
      await replay(vector, node1, pair === undefined ? undefined : cluster.identity(pair));
    }
  } finally {
    for (const index of stopped) await cluster.startNode(index);
  }

  process.stdout.write(`leg 3 replay (cluster3): ${exchanges.length} vectors, ${passed} passed\n`);
  assert.equal(exchanges.length, 10);
  if (failures.length > 0) throw new Error(`${failures.length} of ${exchanges.length} vectors differ:\n${failures.join('\n')}`);
});

/** The zero-based indexes of the nodes a note names with `pattern` ("node3" is index 2). */
function nodesNamed(notes: string, pattern: RegExp): number[] {
  return [...notes.matchAll(pattern)].map((match) => Number(match[1]) - 1);
}

test('an all write with every node up reports three copies', async () => {
  const bucket = await client.database('l9_all').createBucket<{ n: number }>('docs', 'hash');
  const written = await bucket.put('ada', { n: 1 }, { writeConcern: 'all' });
  assert.equal(written.replicationFactor, 3);
  assert.equal(written.copiesConfirmed, 3);
});

test('an all write with one node stopped is answered success with copiesConfirmed below replicationFactor', async () => {
  const bucket = await client.database('l9_stopped').createBucket<{ n: number }>('docs', 'hash');
  await cluster.stopNode(2);
  try {
    const written = await bucket.put('ada', { n: 1 }, { writeConcern: 'all' });
    assert.equal(written.replicationFactor, 3);
    assert.ok(
      written.copiesConfirmed !== undefined && written.copiesConfirmed < 3,
      `copiesConfirmed ${String(written.copiesConfirmed)} is below 3`,
    );
  } finally {
    await cluster.startNode(2);
  }
});

test('a write concern word the server does not know is refused locally before sending', async () => {
  const bucket = await client.database('l9_word').createBucket<{ n: number }>('docs', 'hash');
  const before = client.poolStats().requests;
  await assert.rejects(
    () => bucket.put('ada', { n: 1 }, { writeConcern: 'quorum' as unknown as WriteConcern }),
    InvalidArgumentError,
  );
  assert.equal(client.poolStats().requests, before, 'no frame was sent');
});

test('a write at a node not yet added is UnavailableError with writeOutcome not_applied, retried within the deadline then surfaced', async () => {
  const newcomer = cluster.newcomer ?? (await cluster.startNewcomer());
  const lone = await connect(newcomer.uri(), { tls: TRUST });
  try {
    const bucket = lone.database('l9_newcomer').hash<{ n: number }>('docs');
    await assert.rejects(
      () => bucket.put('ada', { n: 1 }, { timeoutMs: 2_000 }),
      (error: unknown) => error instanceof UnavailableError && error.writeOutcome === 'not_applied',
    );
    assert.ok(lone.poolStats().retries >= 1, `retries ${lone.poolStats().retries} is at least 1`);
  } finally {
    await lone.close({ timeoutMs: 1_000 });
  }
});

test('consistent get reads back a just-acknowledged write', async () => {
  const bucket = await client.database('l9_consistent').createBucket<{ n: number }>('docs', 'hash');
  await bucket.put('ada', { n: 41 });
  assert.equal((await bucket.get('ada', { consistent: true }))?.n, 41);
});

test('alterBucket raises the factor, names the members that copy, and refuses a factor over the cluster', async () => {
  const db = client.database('l9_alter');
  await db.createBucket('users', 'hash', { replicationFactor: 1 });

  const raised = await db.alterBucket('users', { replicationFactor: 3 });
  assert.equal(raised.replicationFactor, 3);
  assert.equal(raised.previousFactor, 1);
  assert.equal(raised.pending?.length, 2, 'the two other members copy the bucket by themselves');
  assert.equal(raised.releasing, undefined);

  const again = await db.alterBucket('users', { replicationFactor: 3 });
  assert.equal(again.replicationFactor, 3);
  assert.equal(again.previousFactor, 3);
  assert.equal(again.pending, undefined, 'a repeat changes nothing');

  const listed = (await db.listBuckets()).find((bucket) => bucket.name === 'users');
  assert.equal(listed?.replicationFactor, 3);
  assert.notEqual(listed?.inherited, true, 'the bucket now declares its factor');

  await assert.rejects(
    () => db.alterBucket('users', { replicationFactor: 4 }),
    (error: unknown) => error instanceof InvalidArgumentError && error.message.length > 0 && error.retryable === false,
  );
});

test('a node that leaves does not break the pool', async () => {
  const [node1, node2] = cluster.nodes;
  assert.ok(node1 !== undefined && node2 !== undefined);
  const bucket = await client.database('l9_leaves').createBucket<{ n: number }>('docs', 'hash');
  await bucket.put('ada', { n: 1 }, { writeConcern: 'all' });

  const pair = await connect({
    hosts: [node1.address, node2.address],
    username: node1.user,
    password: node1.password,
    tls: { fingerprints: [node1.fingerprint, node2.fingerprint], knownServersPath: false },
  });
  try {
    const mine = pair.database('l9_leaves').hash<{ n: number }>('docs');
    assert.equal((await mine.get('ada'))?.n, 1);
    await cluster.stopNode(0);
    for (let at = 0; at < 3; at += 1) {
      assert.equal((await mine.get('ada'))?.n, 1, `read ${at} after node1 left`);
    }
  } finally {
    await pair.close({ timeoutMs: 1_000 });
  }
});

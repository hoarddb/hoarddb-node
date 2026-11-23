// SPDX-License-Identifier: Apache-2.0
//
// put, upsert and the queue and store-field verbs against a real server. put inserts and never
// replaces (DocumentExistsError, nothing written); upsert replaces. The second half pins the shape of
// what pop, peek, claim, ack and the store-field verbs return, so a server that changes an answer is
// caught here and not in a program. Every test uses its own database.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

import {
  DocumentExistsError,
  InvalidArgumentError,
  NotFoundError,
  connect,
  type Client,
  type Doc,
  type KeyedBucket,
} from '../../src/index.js';
import { startServer, type TestServer } from '../helpers/server.js';

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

async function assertExists(promise: Promise<unknown>, operation: string): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof DocumentExistsError, `${operation}: DocumentExistsError, got ${String(error)}`);
    assert.equal(error.code, 'DOCUMENT_EXISTS');
    assert.equal(error.wireCode, 0x12);
    assert.equal(error.writeOutcome, 'not_applied');
    assert.equal(error.retryable, false);
    assert.equal(error.operation, operation);
    assert.match(error.hint ?? '', /upsert\(key, doc\)/);
    return true;
  });
}

test('put of a key that holds a document is DocumentExistsError and leaves the document alone', async () => {
  await client.createDatabase('put_twice');
  const database = client.database('put_twice');
  const typed: readonly (readonly [string, KeyedBucket<Doc>])[] = [
    ['hash', await database.createBucket('h', 'hash')],
    ['btree', await database.createBucket('t', 'btree')],
    ['untyped', database.bucket('h2')],
  ];
  await database.createBucket('h2', 'hash');
  for (const [name, bucket] of typed) {
    const first = await bucket.put('ada', { Name: 'Ada', Age: 36 });
    assert.equal(first.id, 'ada', name);
    await assertExists(bucket.put('ada', { Name: 'Ada Lovelace' }), 'put');
    // The pool is not poisoned by the refusal: the very next call answers.
    assert.deepEqual(await bucket.get('ada'), { _id_: 'ada', Name: 'Ada', Age: 36 }, name);
  }
});

test('insert and insertMany naming a held key are DocumentExistsError, nothing written', async () => {
  await client.createDatabase('insert_twice');
  const users = await client.database('insert_twice').createBucket('users', 'hash');
  await users.put('ada', { Name: 'Ada' });
  await assertExists(users.insert({ _id_: 'ada', Name: 'Ada Lovelace' }), 'insert');
  await assertExists(
    users.insertMany([
      { _id_: 'grace', Name: 'Grace' },
      { _id_: 'ada', Name: 'Ada Lovelace' },
    ]),
    'insertMany',
  );
  assert.equal(await users.exists('grace'), false, 'the batch is refused whole');
  assert.equal(await users.count(), 1);
});

test('upsert creates a missing key and replaces a held one, on hash, btree and an untyped handle', async () => {
  await client.createDatabase('upsert_keys');
  const database = client.database('upsert_keys');
  await database.createBucket('h2', 'hash');
  const typed: readonly (readonly [string, KeyedBucket<Doc>])[] = [
    ['hash', await database.createBucket('h', 'hash')],
    ['btree', await database.createBucket('t', 'btree')],
    ['untyped', database.bucket('h2')],
  ];
  for (const [name, bucket] of typed) {
    const created = await bucket.upsert('ada', { Name: 'Ada', Draft: true });
    assert.equal(created.id, 'ada', name);
    assert.deepEqual(await bucket.get('ada'), { _id_: 'ada', Name: 'Ada', Draft: true }, name);

    const replaced = await bucket.upsert('ada', { Name: 'Ada Lovelace', Born: 1815 });
    assert.equal(replaced.id, 'ada', name);
    // A field the new document lacks is gone: upsert replaces, it does not merge.
    assert.deepEqual(await bucket.get('ada'), { _id_: 'ada', Name: 'Ada Lovelace', Born: 1815 }, name);
    assert.equal(await bucket.count(), 1, name);
  }
});

test('upsert keeps the document\'s own stores', async () => {
  await client.createDatabase('upsert_stores');
  const users = await client.database('upsert_stores').createBucket('User', 'hash', {
    stores: [{ name: 'Purchases', type: 'fifo' }],
  });
  await users.put('ada', { Name: 'Ada' });
  await users.field('ada', 'Purchases').push({ item: 'book' });
  await users.upsert('ada', { Name: 'Ada Lovelace' });
  assert.equal((await users.get('ada')).Name, 'Ada Lovelace');
  assert.equal(await users.field('ada', 'Purchases').len(), 1);
});

test('upsert on a bucket with no key to replace is InvalidArgumentError', async () => {
  await client.createDatabase('upsert_refused');
  const database = client.database('upsert_refused');
  await database.createBucket('fifo', 'fifo');
  await database.createBucket('lifo', 'lifo');
  await database.createBucket('heap', 'heap');
  for (const type of ['fifo', 'lifo', 'heap'] as const) {
    await assert.rejects(database.bucket(type).upsert('ada', { Name: 'Ada' }), (error: unknown) => {
      assert.ok(error instanceof InvalidArgumentError, type);
      assert.equal(error.writeOutcome, 'not_applied', type);
      return true;
    });
    assert.equal(await database.bucket(type).count(), 0, type);
  }
});

test('pop and peek return lists of documents on fifo, lifo and heap', async () => {
  await client.createDatabase('queue_shapes');
  const database = client.database('queue_shapes');
  const fifo = await database.createBucket('f', 'fifo');
  const lifo = await database.createBucket('l', 'lifo');
  const heap = await database.createBucket('p', 'heap');

  assert.deepEqual(await fifo.pop(), [], 'an empty fifo pops an empty list');
  assert.deepEqual(await fifo.peek(), [], 'an empty fifo peeks an empty list');
  assert.deepEqual(await lifo.pop(), []);
  assert.deepEqual(await heap.pop(), []);
  assert.deepEqual(await heap.peek(), []);

  for (const queue of [fifo, lifo]) {
    for (const n of [1, 2, 3]) await queue.push({ n });
  }
  await heap.push({ n: 1 }, { priority: 5 });
  await heap.push({ n: 2 }, { priority: 1 });
  await heap.push({ n: 3 }, { priority: 3 });

  const numbers = (documents: readonly Doc[]): unknown[] => documents.map((document) => document['n']);
  const peeked = await fifo.peek({ limit: 2 });
  assert.deepEqual(numbers(peeked), [1, 2]);
  assert.equal(typeof peeked[0]?._id_, 'string', 'a peeked document carries its _id_');
  const one = await fifo.pop();
  assert.deepEqual(numbers(one), [1], 'pop with no limit is a list of one');
  assert.equal(typeof one[0]?._id_, 'string', 'a popped document carries its _id_');
  assert.deepEqual(numbers(await fifo.pop({ limit: 5 })), [2, 3], 'pop past the end returns what there was');
  assert.deepEqual(await fifo.pop(), []);

  assert.deepEqual(numbers(await lifo.peek({ limit: 1 })), [3]);
  assert.deepEqual(numbers(await lifo.pop({ limit: 2 })), [3, 2]);

  assert.deepEqual(numbers(await heap.peek({ limit: 1 })), [1], 'the highest priority is first');
  assert.deepEqual(numbers(await heap.pop({ limit: 3 })), [1, 3, 2]);
});

test('claim, ack, release and extend return their documented shapes', async () => {
  await client.createDatabase('lease_shapes');
  const jobs = await client.database('lease_shapes').createBucket('jobs', 'fifo');

  const empty = await jobs.claim();
  assert.deepEqual(empty, { leaseId: '', grantedMs: 0, items: [], pending: 0, dead: 0, returned: 0 });

  for (const n of [1, 2, 3]) await jobs.push({ n });
  const claimed = await jobs.claim({ limit: 2, lease: 5_000 });
  assert.match(claimed.leaseId, /^[0-9a-f]{40}$/);
  assert.equal(claimed.grantedMs, 5_000);
  assert.deepEqual(
    claimed.items.map((delivery) => delivery.document['n']),
    [1, 2],
  );
  for (const delivery of claimed.items) {
    assert.equal(typeof delivery.itemId, 'string');
    assert.equal(delivery.deliveries, 1);
    assert.equal(typeof delivery.document._id_, 'string');
  }
  assert.equal(claimed.pending, 2);
  assert.deepEqual(
    (await jobs.peek({ limit: 5 })).map((document) => document['n']),
    [3],
    'claimed entries are invisible to peek',
  );

  assert.equal(await jobs.extend(claimed.leaseId, 10_000), 10_000);
  const first = claimed.items[0];
  assert.ok(first !== undefined);
  const acked = await jobs.ack(claimed.leaseId, { itemIds: [first.itemId] });
  assert.equal(acked.acked, 1);
  assert.equal(acked.remaining, 1);
  const released = await jobs.release(claimed.leaseId);
  assert.equal(released.released, 1);

  const again = await jobs.claim({ limit: 5 });
  assert.deepEqual(
    again.items.map((delivery) => delivery.document['n']),
    [2, 3],
    'the released entry is claimable again, the acked one is gone',
  );
  assert.equal(again.items[0]?.deliveries, 2);
  const all = await jobs.ack(again.leaseId);
  assert.equal(all.acked, 2);
  assert.equal(await jobs.count(), 0);
});

test('the store-field verbs return their documented shapes', async () => {
  await client.createDatabase('field_shapes');
  const users = await client.database('field_shapes').createBucket('User', 'hash', {
    stores: [
      { name: 'Purchases', type: 'fifo' },
      { name: 'Friends', type: 'hash' },
    ],
  });
  await users.put('ada', { Name: 'Ada' });

  const purchases = users.field<{ item: string }>('ada', 'Purchases');
  assert.deepEqual(await purchases.pop(), [], 'an empty store field pops an empty list');
  assert.deepEqual(await purchases.peek(), []);
  assert.equal(await purchases.len(), 0);
  const pushed = await purchases.push({ item: 'book' });
  assert.equal(typeof pushed.entryId, 'string');
  await purchases.push({ item: 'pen' });
  await purchases.push({ item: 'ink' });
  assert.equal(await purchases.len(), 3);
  assert.deepEqual(
    (await purchases.peek({ limit: 2 })).map((entry) => entry.element?.item),
    ['book', 'pen'],
  );
  assert.deepEqual(
    (await purchases.pop()).map((entry) => entry.element?.item),
    ['book'],
    'pop with no limit is a list of one entry',
  );
  assert.deepEqual(
    (await purchases.pop({ limit: 5 })).map((entry) => entry.element?.item),
    ['pen', 'ink'],
  );
  assert.equal(await purchases.len(), 0);

  const friends = users.field<{ since: number }>('ada', 'Friends');
  const put = await friends.put('bob', { since: 2020 });
  assert.equal(put.elementKey, 'bob');
  // A store field's put replaces the element: it has no upsert because it never refuses a held one.
  await friends.put('bob', { since: 2021 });
  const bob = await friends.get('bob');
  assert.equal(bob.element?.since, 2021);
  assert.equal(bob.elementKey, 'bob');
  assert.equal(await friends.len(), 1);
  assert.deepEqual(
    (await friends.list().toArray()).map((entry) => [entry.elementKey, entry.element?.since]),
    [['bob', 2021]],
  );
  await assert.rejects(friends.get('carol'), NotFoundError);
  assert.equal(await friends.delete('bob'), true);
  assert.equal(await friends.delete('bob'), false);
});

test('put of a held key is refused only on hash and btree: a queue adds an entry and a heap replaces one', async () => {
  await client.createDatabase('put_on_queues');
  const database = client.database('put_on_queues');
  await database.createBucket('f', 'fifo');
  await database.createBucket('l', 'lifo');
  const heap = await database.createBucket('p', 'heap');

  for (const name of ['f', 'l']) {
    const queue = database.bucket(name);
    await queue.put('k', { n: 1 });
    await queue.put('k', { n: 2 });
    assert.equal(await queue.count(), 2, `${name}: the second put is a second entry`);
    assert.deepEqual(
      (await queue.peek({ limit: 5 })).map((entry) => entry._id_),
      ['k', 'k'],
      `${name}: both entries carry the same _id_`,
    );
  }

  const untyped = database.bucket('p');
  await untyped.put('k', { n: 1 });
  await untyped.put('k', { n: 2 });
  assert.equal(await heap.count(), 1, 'a heap keeps one entry for an _id_ at one priority');
  assert.deepEqual(await heap.peek({ limit: 5 }), [{ _id_: 'k', n: 2 }], 'and the later put replaced it');
  await heap.push({ _id_: 'k', n: 3 }, { priority: 5 });
  assert.equal(await heap.count(), 2, 'the same _id_ at another priority is another entry');
});

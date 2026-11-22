// SPDX-License-Identifier: Apache-2.0
//
// Queries, cursors, batches and store fields against a real server. One server serves the file,
// except the two result-ceiling tests, which share a second one started with a 1 MiB ceiling. Every
// test uses its own database, so the order of the tests never matters.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { ConfigError, InvalidArgumentError, NotFoundError, ResultTooLargeError, connect, type Client } from '../../src/index.js';
import { startServer, type TestServer } from '../helpers/server.js';

const TRUST = { knownServersPath: false } as const;

let server: TestServer;
let client: Client;
let tight: TestServer;
let tightClient: Client;

before(async () => {
  server = await startServer();
  client = await connect(server.uri(), { tls: TRUST });
  tight = await startServer({ env: { HOARDDB_QUERY_MAX_RESULT_BYTES: '1048576' } });
  tightClient = await connect(tight.uri(), { tls: TRUST });
});

after(async () => {
  await client?.close({ timeoutMs: 1_000 });
  await tightClient?.close({ timeoutMs: 1_000 });
  await server?.stop();
  await tight?.stop();
});

test('find pages through 250 documents in three pages with total 250', async () => {
  const bucket = await client.database('paging').createBucket<{ n: number }>('docs', 'hash');
  await bucket.insertMany(Array.from({ length: 250 }, (_, n) => ({ n })));

  const before = client.poolStats().requests;
  const cursor = bucket.find({}, { pageSize: 100 });
  const found = await cursor.toArray();
  assert.equal(found.length, 250);
  assert.equal(cursor.total, 250);
  assert.equal(client.poolStats().requests - before, 3, 'three SCAN requests');
});

test('find of a missing bucket is NotFoundError', async () => {
  await client.createDatabase('no_bucket');
  await assert.rejects(() => client.database('no_bucket').hash('missing').find({}).toArray(), NotFoundError);
});

test('range walks a btree in order and is stable under inserts', async () => {
  const bucket = await client.database('ranges').createBucket<{ n: number }>('tree', 'btree');
  const originals = Array.from({ length: 200 }, (_, n) => `k${String(n).padStart(3, '0')}`);
  for (const key of originals) await bucket.put(key, { n: 1 });

  const walked: string[] = [];
  let inserted = false;
  for await (const entry of bucket.range({}, { pageSize: 50 })) {
    walked.push(entry.key);
    if (!inserted) {
      // The first page is in hand: keys ahead of the walk go in now.
      inserted = true;
      await bucket.put('k0505', { n: 2 });
      await bucket.put('k1505', { n: 2 });
    }
  }
  assert.deepEqual(walked.filter((key) => originals.includes(key)), originals, 'every original key once, in order');
  assert.equal(new Set(walked).size, walked.length, 'no key twice');
  assert.deepEqual([...walked].sort(), walked, 'in key order');
});

test('search finds documents through a declared index', async () => {
  const bucket = await client.database('searching').createBucket<{ Field: string }>('docs', 'hash', {
    indexes: [{ fields: ['Field'] }],
  });
  await bucket.put('a', { Field: 'computing' });
  await bucket.put('b', { Field: 'biology' });
  await bucket.put('c', { Field: 'computing' });
  const found = await bucket.search({ Field: 'computing' }).toArray();
  assert.deepEqual(found.map((doc) => doc._id_).sort(), ['a', 'c']);
});

test('search says when it was cut: total is the number returned, hasMore the rest', async () => {
  const bucket = await client.database('search_cut').createBucket<{ Field: string }>('docs', 'hash', {
    indexes: [{ fields: ['Field'] }],
  });
  for (const id of ['a', 'b', 'c']) await bucket.put(id, { Field: 'computing' });

  const cut = bucket.search({ Field: 'computing' }, { limit: 2 });
  assert.equal((await cut.toArray()).length, 2);
  assert.equal(cut.total, 2, 'the number returned, not the three that match');
  assert.equal(cut.hasMore, true);

  const whole = bucket.search({ Field: 'computing' }, { limit: 3 });
  assert.equal((await whole.toArray()).length, 3);
  assert.equal(whole.hasMore, false, 'exactly limit matches is a complete answer');
});

test('find of a blob bucket is a refusal, not a missing bucket', async () => {
  const database = client.database('blob_find');
  await database.createBucket('files', 'blob');
  await assert.rejects(() => database.bucket('files').find({}).toArray(), InvalidArgumentError);
});

test('insertMany on a queue reports the ids it pushed, and on a blob is refused', async () => {
  const database = client.database('queue_batch');
  await database.createBucket('fifo', 'fifo');
  await database.createBucket('lifo', 'lifo');
  for (const type of ['fifo', 'lifo']) {
    const result = await database.bucket<{ n: number }>(type).insertMany([{ n: 1 }, { n: 2 }, { n: 3 }]);
    assert.equal(result.count, 3, `${type}: count`);
    assert.equal(result.ids.length, 3, `${type}: ids`);
  }
  await database.createBucket('files', 'blob');
  await assert.rejects(() => database.bucket('files').insertMany([{ n: 1 }]), InvalidArgumentError);
});

test('info reads the declaration of a bucket with store fields of every engine, in one request', async () => {
  const database = client.database('info_fields');
  const users = await database.createBucket<{ Name: string }>('User', 'hash', {
    stores: [
      { name: 'Friends', type: 'hash' },
      { name: 'Purchases', type: 'fifo' },
      { name: 'Photos', type: 'lifo' },
      { name: 'Recipes', type: 'btree' },
      { name: 'Books', type: 'heap' },
      { name: 'Data', type: 'blob' },
    ],
  });
  await users.put('ada', { Name: 'Ada' });
  await users.field('ada', 'Purchases').push({ item: 'book' });

  const before = client.poolStats().requests;
  const declaration = await users.info();
  assert.equal(client.poolStats().requests - before, 1, 'one round trip, no BUCKET_STATS');
  assert.equal(declaration.name, 'User');
  assert.equal(declaration.type, 'hash');
  assert.equal(declaration.entries, 1, "the bucket's own documents, not its stores' elements");
  assert.deepEqual(declaration.stores, ['Friends', 'Purchases', 'Photos', 'Recipes', 'Books', 'Data']);
  assert.deepEqual(declaration.storeFields, [
    { name: 'Friends', engine: 'hash' },
    { name: 'Purchases', engine: 'fifo' },
    { name: 'Photos', engine: 'lifo' },
    { name: 'Recipes', engine: 'btree' },
    { name: 'Books', engine: 'heap' },
    { name: 'Data', engine: 'blob' },
  ]);
  assert.equal(typeof declaration.replicationFactor, 'number');
});

test('info of a bucket with no store fields, on a typed and on a generic handle', async () => {
  const database = client.database('info_plain');
  await database.createBucket('queue', 'fifo');
  const declaration = await database.bucket('queue').info();
  assert.deepEqual([declaration.name, declaration.type, declaration.stores, declaration.storeFields], ['queue', 'fifo', [], []]);
  assert.equal((await database.fifo('queue').info()).type, 'fifo');
});

test('info of a missing bucket and of a missing database is NotFoundError', async () => {
  await client.createDatabase('info_missing');
  await assert.rejects(() => client.database('info_missing').hash('nope').info(), NotFoundError);
  await assert.rejects(() => client.database('info_no_such_database').hash('nope').info(), NotFoundError);
});

test('health reports the host the node runs on', async () => {
  const health = await client.health();
  assert.ok(health.host !== undefined, 'a current server sends host');
  assert.ok(health.host.cpus >= 1);
});

test('a cursor halves its page as often as needed on RESULT_TOO_LARGE and then reads everything', async () => {
  const bucket = await tightClient.database('big').createBucket<{ text: string }>('three', 'hash');
  for (const key of ['a', 'b', 'c']) await bucket.put(key, { text: 'x'.repeat(400_000) });
  const found = await bucket.find({}, { pageSize: 3 }).toArray();
  assert.equal(found.length, 3);
});

test('a document that cannot fit is reported after exactly two requests', async () => {
  const bucket = await tightClient.database('big').createBucket<{ text: string }>('one', 'hash');
  await bucket.put('only', { text: 'x'.repeat(1_100_000) });

  const before = tightClient.poolStats().requests;
  await assert.rejects(
    () => bucket.find({}, { pageSize: 2 }).toArray(),
    (error: unknown) =>
      error instanceof ResultTooLargeError &&
      error.maxResultBytes === 1_048_576 &&
      typeof error.retainedBytes === 'number',
  );
  assert.equal(tightClient.poolStats().requests - before, 2);
});

test('insertMany returns every id', async () => {
  const bucket = await client.database('batches').createBucket<{ n: number }>('docs', 'hash');
  const docs = [
    ...Array.from({ length: 7 }, (_, n) => ({ n })),
    { _id_: 'chosen', n: 100 },
  ];
  const result = await bucket.insertMany(docs);
  assert.equal(result.ids.length, 8);
  assert.equal(result.count, 8);
  assert.ok(result.ids.includes('chosen'));
  for (const id of result.ids) assert.notEqual(await bucket.get(id), null, `document ${id} is stored`);
});

test('insertMany splits a batch over the atomic bound', async () => {
  const bucket = await client.database('big_batch').createBucket<{ n: number; text: string }>('docs', 'hash');
  const text = 'y'.repeat(30_000);
  const result = await bucket.insertMany(Array.from({ length: 200 }, (_, n) => ({ n, text })));
  assert.equal(result.count, 200);
  assert.equal(await bucket.count(), 200, 'every document is stored once');
});

test('each document has its own store field', async () => {
  const users = await client.database('fields').createBucket<{ Name: string }>('User', 'hash', {
    stores: [{ name: 'Purchases', type: 'fifo' }],
  });
  await users.put('ada', { Name: 'Ada' });
  await users.put('bob', { Name: 'Bob' });
  const ada = users.field<{ item: string }>('ada', 'Purchases');
  const bob = users.field<{ item: string }>('bob', 'Purchases');
  await ada.push({ item: 'a1' });
  await ada.push({ item: 'a2' });
  await bob.push({ item: 'b1' });

  assert.equal((await ada.pop())[0]?.element?.item, 'a1');
  assert.equal((await ada.pop())[0]?.element?.item, 'a2');
  assert.equal((await bob.pop())[0]?.element?.item, 'b1');
  assert.deepEqual(await bob.pop(), [], 'bob has only his own purchases');
  await ada.push({ item: 'a3' });
  await ada.push({ item: 'a4' });
  await ada.push({ item: 'a5' });
  assert.deepEqual((await ada.pop({ limit: 2 })).map((entry) => entry.element?.item), ['a3', 'a4']);
  assert.deepEqual((await ada.pop({ limit: 2 })).map((entry) => entry.element?.item), ['a5']);
});

test('a nested store through an element', async () => {
  const users = await client.database('nested').createBucket<{ Name: string }>('User', 'hash', {
    stores: [{ name: 'Recipes', type: 'btree', stores: [{ name: 'Steps', type: 'fifo' }] }],
  });
  await users.put('ada', { Name: 'Ada' });
  const recipes = users.field<{ title: string }>('ada', 'Recipes');
  await recipes.put('pie', { title: 'pie' });
  const steps = recipes.field<{ n: number }>('pie', 'Steps');
  await steps.push({ n: 1 });
  assert.equal(await steps.len(), 1);
});

test('field list pages with next', async () => {
  const users = await client.database('field_list').createBucket<{ Name: string }>('User', 'hash', {
    stores: [{ name: 'Log', type: 'fifo' }],
  });
  await users.put('ada', { Name: 'Ada' });
  const log = users.field<{ n: number }>('ada', 'Log');
  for (let n = 0; n < 2_500; n += 1) await log.push({ n });

  const before = client.poolStats().requests;
  const entries = await log.list({ pageSize: 1_000 }).toArray();
  assert.equal(entries.length, 2_500);
  assert.equal(client.poolStats().requests - before, 3, 'three pages');
});

test('defaultDatabase is the database the connection names, and its handle works', async () => {
  const named = await connect(server.uri(), { tls: TRUST, database: 'dflt' });
  try {
    const database = named.defaultDatabase();
    assert.equal(database.name, 'dflt');
    const bucket = await database.createBucket<{ n: number }>('docs', 'hash');
    await bucket.put('a', { n: 1 });
    assert.deepEqual((await database.open('docs')).name, 'docs');
    assert.throws(() => client.defaultDatabase(), (error: unknown) => error instanceof ConfigError);
  } finally {
    await named.close({ timeoutMs: 1_000 });
  }
});

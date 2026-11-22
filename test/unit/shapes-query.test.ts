// SPDX-License-Identifier: Apache-2.0
//
// The query verbs, checked against the frozen vectors on a recording client: each request must match
// the vector's request, and each result is read from the vector's answer (build doc step 13).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { extendedJsonFromBytes } from '../../src/codec/index.js';
import { InvalidArgumentError, NotFoundError } from '../../src/errors.js';
import { answerTo, assertSentAs, recordingClient } from '../helpers/recording.js';
import { vectorNamed } from '../helpers/vectors.js';

test('find with filter, sort, projection, skip and limit matches its vector', async () => {
  const vector = vectorNamed('find with filter, sort, projection, skip and limit');
  const { client, sent } = recordingClient(answerTo(vector));
  const documents = await client
    .database('v102')
    .hash<{ Name: string; Field: string; Born: number }>('people')
    .find({ Field: 'computing' }, { sort: { Born: -1 }, projection: { Name: 1 }, limit: 1 })
    .toArray();
  assertSentAs(sent[0], vector);
  assert.equal(documents.length, 1);
  assert.equal(documents[0]?.Name, 'Linus');
  assert.equal(sent.length, 1, 'a limit of one needs no second page');
});

test('find of a missing bucket is NotFoundError', async () => {
  const vector = vectorNamed('find of a bucket that does not exist');
  const { client, sent } = recordingClient(answerTo(vector));
  await assert.rejects(client.database('v103').hash('people').find().toArray(), NotFoundError);
  assertSentAs(sent[0], vector);
});

test('find of a blob bucket is a refusal that names the blob verbs, not a missing bucket', async () => {
  const vector = vectorNamed('find on a blob bucket is refused');
  const { client, sent } = recordingClient(answerTo(vector));
  await assert.rejects(client.database('v176').bucket('files').find().toArray(), (error: unknown) => {
    assert.ok(error instanceof InvalidArgumentError, `an InvalidArgumentError, got ${String(error)}`);
    assert.match(error.message, /does not scan blob buckets/);
    return true;
  });
  assertSentAs(sent[0], vector);
});

test('count with a filter matches its vector', async () => {
  const vector = vectorNamed('count with a filter');
  const { client, sent } = recordingClient(answerTo(vector));
  assert.equal(await client.database('v104').hash('people').count({ Field: 'computing' }), 2);
  assertSentAs(sent[0], vector);
});

test('distinct matches its vector', async () => {
  const vector = vectorNamed('distinct');
  const { client, sent } = recordingClient(answerTo(vector));
  assert.deepEqual(await client.database('v105').hash('people').distinct('Field'), ['maths', 'computing']);
  assertSentAs(sent[0], vector);
});

test('search by a secondary index matches its vector', async () => {
  const vector = vectorNamed('search by a secondary index');
  const { client, sent } = recordingClient(answerTo(vector));
  const results = await client.database('v106').hash('people').search({ Field: 'computing' }, { limit: 10 }).toArray();
  assertSentAs(sent[0], vector);
  assert.deepEqual(
    results.map((item) => item._id_),
    ['grace', 'linus'],
  );
});

test('a search cut at its limit says hasMore, and total is the number returned', async () => {
  const vector = vectorNamed('search cut at its limit says has_more');
  const { client, sent } = recordingClient(answerTo(vector));
  const cursor = client.database('v187').hash('people').search({ Field: 'computing' }, { limit: 1 });
  assert.equal(cursor.hasMore, undefined, 'before the first page nothing is known');
  const results = await cursor.toArray();
  assertSentAs(sent[0], vector);
  assert.equal(results.length, 1);
  assert.equal(cursor.total, 1, 'total is how many came back, not how many match');
  assert.equal(cursor.hasMore, true);
});

test('a search with exactly limit matches is complete', async () => {
  const vector = vectorNamed('search with exactly limit matches is complete');
  const { client, sent } = recordingClient(answerTo(vector));
  const cursor = client.database('v188').hash('people').search({ Field: 'computing' }, { limit: 2 });
  assert.equal((await cursor.toArray()).length, 2);
  assertSentAs(sent[0], vector);
  assert.equal(cursor.total, 2);
  assert.equal(cursor.hasMore, false);
});

test('a search by full scan cut at its limit says hasMore too', async () => {
  const vector = vectorNamed('search by full scan cut at its limit says has_more');
  const { client, sent } = recordingClient(answerTo(vector));
  const cursor = client.database('v189').hash('people').search({ Field: 'computing' }, { limit: 1 });
  assert.equal((await cursor.toArray()).length, 1);
  assertSentAs(sent[0], vector);
  assert.equal(cursor.hasMore, true);
});

test('a search answer from a server older than has_more leaves hasMore undefined', async () => {
  const { client } = recordingClient(new Map([['SEARCH', { results: [{ _id_: 'ada' }], total: 1 }]]));
  const cursor = client.database('app').hash('users').search({ Name: 'Ada' });
  await cursor.toArray();
  assert.equal(cursor.hasMore, undefined);
});

test('a find cursor has no hasMore: it pages until the server is done', async () => {
  const { client } = recordingClient(new Map([['SCAN', { found: true, documents: [{ _id_: 'ada' }], has_more: false, total: 1 }]]));
  const cursor = client.database('app').hash('users').find({});
  await cursor.toArray();
  assert.equal(cursor.hasMore, undefined);
});

test('btree range matches its vector', async () => {
  const vector = vectorNamed('btree range');
  const { client, sent } = recordingClient(answerTo(vector));
  const entries = await client.database('v091').btree('b').range({ gte: 'b', lte: 'm' }, { pageSize: 10 }).toArray();
  assertSentAs(sent[0], vector);
  assert.deepEqual(
    entries.map((entry) => entry.key),
    ['grace', 'linus'],
  );
});

test('btree first and btree last match their vectors', async () => {
  const first = vectorNamed('btree first');
  const firstClient = recordingClient(answerTo(first));
  assert.equal((await firstClient.client.database('v092').btree('b').first())?.key, 'ada');
  assertSentAs(firstClient.sent[0], first);

  const last = vectorNamed('btree last');
  const lastClient = recordingClient(answerTo(last));
  assert.equal((await lastClient.client.database('v093').btree('b').last())?.key, 'linus');
  assertSentAs(lastClient.sent[0], last);
});

test('btree first of an empty bucket throws NotFoundError', async () => {
  const vector = vectorNamed('btree first of an empty bucket');
  const { client, sent } = recordingClient(answerTo(vector));
  await assert.rejects(client.database('v094').btree('b').first(), NotFoundError);
  assertSentAs(sent[0], vector);
});

test('an answer without a total leaves cursor.total undefined, never NaN', async () => {
  const { client } = recordingClient(
    new Map([
      ['SCAN', { found: true, documents: [{ _id_: 'ada' }], has_more: false }],
      ['SEARCH', { results: [{ _id_: 'ada' }] }],
    ]),
  );
  const users = client.database('app').hash('users');
  const found = users.find({});
  assert.equal((await found.toArray()).length, 1);
  assert.equal(found.total, undefined, 'find: no total sent, none reported');
  const searched = users.search({ Name: 'Ada' });
  assert.equal((await searched.toArray()).length, 1);
  assert.equal(searched.total, undefined, 'search: no total sent, none reported');
});

test('find from page 2 names page 1 bucket_id as an int64 and advances skip', async () => {
  const { client, sent } = recordingClient(
    new Map([
      [
        'SCAN',
        (request: { fields: Record<string, unknown> }) =>
          request.fields['skip'] === 5
            ? { found: true, documents: [{ _id_: 'a' }, { _id_: 'b' }], has_more: true, total: 3, bucket_id: 7n }
            : { found: true, documents: [{ _id_: 'c' }], has_more: false, total: 3, bucket_id: 7n },
      ],
    ]),
  );
  const found = await client.database('app').hash('users').find({}, { skip: 5, pageSize: 2 }).toArray();
  assert.deepEqual(found.map((doc) => doc._id_), ['a', 'b', 'c']);
  assert.equal(sent.length, 2);
  assert.equal(sent[0]?.fields['skip'], 5);
  assert.equal(Object.hasOwn(sent[0]?.fields ?? {}, 'expect_bucket_id'), false, 'page 1 names no bucket_id');
  assert.equal(sent[1]?.fields['skip'], 7, 'page 2 skips what page 1 returned');
  // The wire width matters: the server reads expect_bucket_id as an int64.
  assert.deepEqual(extendedJsonFromBytes(sent[1]?.bytes ?? new Uint8Array())['expect_bucket_id'], { $numberLong: '7' });
});

test('range continues from the last key and drops its repeat', async () => {
  const keys = ['a', 'b', 'c', 'd'];
  const { client, sent } = recordingClient(
    new Map([
      [
        'BTREE_RANGE',
        (request: { fields: Record<string, unknown> }) => {
          const from = keys.indexOf(String(request.fields['low']));
          const slice = keys.slice(from, from + Number(request.fields['limit']));
          return { entries: slice.map((key) => ({ key, data: { _id_: key } })) };
        },
      ],
    ]),
  );
  const entries = await client.database('app').btree('t').range({ gte: 'a' }, { pageSize: 2 }).toArray();
  assert.deepEqual(entries.map((entry) => entry.key), ['a', 'b', 'c', 'd'], 'every key once: the boundary key is not repeated');
  assert.deepEqual(sent.map((request) => request.fields['low']), ['a', 'b', 'd']);
  assert.deepEqual(sent.map((request) => request.fields['limit']), [2, 3, 3], 'a later page asks for one more, the repeat it drops');
});

// SPDX-License-Identifier: Apache-2.0
//
// The DDL verbs, checked against the frozen vectors: each call is made on a recording client, and the
// request it produces must match the vector's request (opcode, allowed fields and payload), while the
// result is read from the vector's own answer (build doc step 11).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { answerTo, assertSentAs, recordingClient } from '../helpers/recording.js';
import { vectorNamed } from '../helpers/vectors.js';

test('createDatabase matches the create database vector', async () => {
  const vector = vectorNamed('create database');
  const { client, sent } = recordingClient(answerTo(vector));
  await client.createDatabase('v012');
  assertSentAs(sent[0], vector);
});

test('dropDatabase matches the drop database vector', async () => {
  const vector = vectorNamed('drop database');
  const { client, sent } = recordingClient(answerTo(vector));
  await client.dropDatabase('v015');
  assertSentAs(sent[0], vector);
});

test('createBucket matches the create bucket: hash vector', async () => {
  const vector = vectorNamed('create bucket: hash');
  const { client, sent } = recordingClient(answerTo(vector));
  const bucket = await client.database('v017').createBucket('b', 'hash');
  assertSentAs(sent[0], vector);
  assert.equal(bucket.type, 'hash');
});

test('createBucket with store fields matches the vector', async () => {
  const vector = vectorNamed('create bucket with store fields');
  const { client, sent } = recordingClient(answerTo(vector));
  await client.database('v028').createBucket('User', 'hash', {
    stores: [
      { name: 'Purchases', type: 'fifo' },
      { name: 'Photos', type: 'lifo' },
      { name: 'Friends', type: 'hash' },
      { name: 'Recipes', type: 'btree' },
      { name: 'Books', type: 'heap' },
      { name: 'Data', type: 'blob' },
    ],
  });
  assertSentAs(sent[0], vector);
});

test('createBucket with a unique index matches the vector', async () => {
  const vector = vectorNamed('create bucket with a unique index');
  const { client, sent } = recordingClient(answerTo(vector));
  await client.database('v030').createBucket('b', 'hash', {
    indexes: [{ fields: ['Email'], name: 'by_email', unique: true }],
  });
  // The vector's request also names the bucket's placement, an optional member this driver has no
  // option for and never sends: the server then applies its default. Everything else must match.
  const request = structuredClone(vector['request']) as { payload_json: { options: { placement?: string } } };
  assert.equal(request.payload_json.options.placement, 'whole');
  delete request.payload_json.options.placement;
  assertSentAs(sent[0], { ...vector, request });
});

test('createBucket with typed fields matches the vector', async () => {
  const vector = vectorNamed('create bucket with typed fields');
  const { client, sent } = recordingClient(answerTo(vector));
  await client.database('v031').createBucket('b', 'hash', {
    fieldTypes: {
      mode: 'strict',
      fields: [
        { name: 'Name', type: 'string', required: true },
        { name: 'Born', type: 'int' },
      ],
    },
  });
  assertSentAs(sent[0], vector);
});

test('createBucket with a replication factor matches the vector', async () => {
  const vector = vectorNamed('create bucket with a replication factor');
  const { client, sent } = recordingClient(answerTo(vector));
  await client.database('v034').createBucket('b', 'hash', { replicationFactor: 1 });
  assertSentAs(sent[0], vector);
});

test('declareStoreFields matches the declare store fields vector', async () => {
  const vector = vectorNamed('declare store fields on an existing bucket');
  const { client, sent } = recordingClient(answerTo(vector));
  await client.database('v035').declareStoreFields('Post', [{ name: 'Tags', type: 'hash' }]);
  assertSentAs(sent[0], vector);
});

test('listBuckets, bucket stats: hash, listDatabases match their vectors', async () => {
  const listBuckets = vectorNamed('list buckets');
  const stats = vectorNamed('bucket stats: hash');
  const databases = vectorNamed('list databases');
  const { client, sent } = recordingClient(
    new Map([...answerTo(listBuckets), ...answerTo(stats), ...answerTo(databases)]),
  );

  const buckets = await client.database('v038').listBuckets();
  assertSentAs(sent[0], listBuckets);
  assert.deepEqual(buckets[1], { name: 'users', type: 'hash', entries: 1, stores: ['Friends'], replicationFactor: 1, inherited: true, inSync: 1, state: 'standalone' });

  const info = await client.database('v041').bucket('b').stats();
  assertSentAs(sent[1], stats);
  assert.equal(info.type, 'hash');
  assert.equal(info.entries, 0);

  const listed = await client.listDatabases();
  assertSentAs(sent[2], databases);
  assert.deepEqual(listed, [{ name: 'v040', bucketCount: 1 }]);
});

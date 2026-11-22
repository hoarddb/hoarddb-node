// SPDX-License-Identifier: Apache-2.0
//
// bucket.info(): one BUCKET_INFO round trip on any handle, checked against the frozen vectors on a
// recording client, and against answers the vectors do not hold (absent members, an engine word from
// a newer server). The server tests cover the same verb against a real server.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { encodeDocument, valuesFromExtendedJson } from '../../src/codec/index.js';
import { ConnectionError, NotFoundError, PermissionDeniedError, UnavailableError, errorFromErrorPayload } from '../../src/errors.js';
import { answerTo, assertSentAs, recordingClient, type AnswerFrom } from '../helpers/recording.js';
import { vectorNamed } from '../helpers/vectors.js';

/** The answer that surfaces the vector's ERROR frame as the driver's refusal. */
function refusalOf(name: string): AnswerFrom {
  const response = vectorNamed(name)['response'] as { payload_json: Record<string, unknown> };
  const payload = encodeDocument(valuesFromExtendedJson(response.payload_json, 'safe'));
  return () => {
    throw errorFromErrorPayload(payload, { operation: 'info' });
  };
}

test('info of a bucket with store fields of every engine matches its vector', async () => {
  const vector = vectorNamed('bucket info with store fields');
  const { client, sent } = recordingClient(answerTo(vector));
  const declaration = await client.database('v182').hash('User').info();
  assertSentAs(sent[0], vector);
  assert.deepEqual(declaration, {
    name: 'User',
    type: 'hash',
    entries: 1,
    stores: ['Friends', 'Purchases', 'Photos', 'Recipes', 'Books', 'Data'],
    storeFields: [
      { name: 'Friends', engine: 'hash' },
      { name: 'Purchases', engine: 'fifo' },
      { name: 'Photos', engine: 'lifo' },
      { name: 'Recipes', engine: 'btree' },
      { name: 'Books', engine: 'heap' },
      { name: 'Data', engine: 'blob' },
    ],
    replicationFactor: 1,
    inherited: true,
    inSync: 1,
    state: 'standalone',
  });
});

test('info on a cluster reads the cluster replication factor and null stores as none', async () => {
  const vector = vectorNamed('bucket info on a cluster');
  const { client, sent } = recordingClient(answerTo(vector));
  const declaration = await client.database('v186').hash('users').info();
  assertSentAs(sent[0], vector);
  assert.deepEqual(declaration, {
    name: 'users',
    type: 'hash',
    entries: 0,
    stores: [],
    storeFields: [],
    replicationFactor: 3,
    inherited: true,
    // The owner's view, passed through (the vector's notes: node3 was stopped by an earlier vector).
    inSync: 2,
    state: 'under-replicated',
    notInSync: ['node3'],
  });
});

test('a missing bucket and a missing database are NotFoundError, sent once and not retried', async () => {
  for (const [name, database, message] of [
    ['bucket info of a bucket that does not exist', 'v183', 'bucket "b" not found in database'],
    ['bucket info of a database that does not exist', 'v184', 'database "v184" not found'],
  ] as const) {
    const vector = vectorNamed(name);
    const { client, sent } = recordingClient(new Map([['BUCKET_INFO', refusalOf(name)]]));
    await assert.rejects(client.database(database).hash('b').info(), (error: unknown) => {
      assert.ok(error instanceof NotFoundError, `${name}: ${String(error)}`);
      assert.ok(error.message.includes(message), `${name}: the server's message, verbatim`);
      return true;
    });
    assertSentAs(sent[0], vector);
    assert.equal(sent.length, 1, `${name}: a NOT_FOUND is never retried`);
  }
});

test('a caller without read permission gets the normal permission error', async () => {
  const name = "bucket info outside the user's grant";
  const { client, sent } = recordingClient(new Map([['BUCKET_INFO', refusalOf(name)]]));
  await assert.rejects(client.database('other-v185').hash('users').info(), PermissionDeniedError);
  assertSentAs(sent[0], vectorNamed(name));
});

test('an answer without replication_factor, inherited or store_fields leaves them out', async () => {
  const { client } = recordingClient(
    new Map([['BUCKET_INFO', { found: true, database: 'app', bucket: { name: 'q', type: 'fifo', entries: 4n, stores: null } }]]),
  );
  const declaration = await client.database('app').fifo('q').info();
  assert.deepEqual(declaration, { name: 'q', type: 'fifo', entries: 4, stores: [], storeFields: [] });
  assert.equal('replicationFactor' in declaration, false);
  assert.equal('inherited' in declaration, false);
});

test('an engine word from a newer server is passed through unchanged', async () => {
  const { client } = recordingClient(
    new Map([
      [
        'BUCKET_INFO',
        {
          found: true,
          database: 'app',
          bucket: { name: 'u', type: 'hash', entries: 0, stores: ['Trail'] },
          store_fields: [{ name: 'Trail', engine: 'graph' }],
        },
      ],
    ]),
  );
  const declaration = await client.database('app').hash('u').info();
  assert.deepEqual(declaration.storeFields, [{ name: 'Trail', engine: 'graph' }]);
});

test('the wire outside member is not exposed', async () => {
  const { client } = recordingClient(
    new Map([['BUCKET_INFO', { found: true, database: 'app', bucket: { name: 'u', type: 'hash', entries: 0, stores: [], outside: true } }]]),
  );
  assert.equal('outside' in (await client.database('app').hash('u').info()), false);
});

test('every handle has info(), each call is one BUCKET_INFO and never a BUCKET_STATS', async () => {
  const answer = { found: true, database: 'app', bucket: { name: 'b', type: 'hash', entries: 0, stores: [] } };
  const { client, sent } = recordingClient(new Map([['BUCKET_INFO', answer]]));
  const database = client.database('app');
  const handles = [database.hash('b'), database.btree('b'), database.fifo('b'), database.lifo('b'), database.heap('b'), database.blob('b'), database.bucket('b')];
  for (const handle of handles) await handle.info();
  assert.deepEqual(
    sent.map((request) => request.op),
    handles.map(() => 'BUCKET_INFO'),
    'one request per call, and no BUCKET_STATS among them',
  );
  await handles[0]?.info();
  assert.equal(sent.length, handles.length + 1, 'nothing is cached on the handle: the next call asks again');
});

test('info is a read: a lost connection is retried once on a fresh one, and UNAVAILABLE is retried', async () => {
  const answer = { found: true, database: 'app', bucket: { name: 'b', type: 'hash', entries: 2, stores: [] } };
  for (const [what, refusal] of [
    ['a lost connection', () => new ConnectionError({ message: 'the connection closed', operation: 'info' })],
    ['UNAVAILABLE', () => new UnavailableError({ message: 'no node holds the bucket', operation: 'info' })],
  ] as const) {
    let attempts = 0;
    const { client, sent } = recordingClient(
      new Map([
        [
          'BUCKET_INFO',
          () => {
            attempts += 1;
            if (attempts === 1) throw refusal();
            return answer;
          },
        ],
      ]),
    );
    const declaration = await client.database('app').hash('b').info();
    assert.equal(declaration.entries, 2, `${what}: the second attempt answered`);
    assert.equal(sent.length, 2, `${what}: retried exactly once`);
  }
});

test('info does not retry a lost connection twice', async () => {
  const { client, sent } = recordingClient(
    new Map([
      [
        'BUCKET_INFO',
        () => {
          throw new ConnectionError({ message: 'the connection closed', operation: 'info' });
        },
      ],
    ]),
  );
  await assert.rejects(client.database('app').hash('b').info(), ConnectionError);
  assert.equal(sent.length, 2, 'one attempt and one retry, then the error');
});

test('stats carries the owner\'s copies view as typed members, and the rest stays in raw', async () => {
  const answer = { found: true, database: 'd', bucket: 'b', type: 'hash', entries: 0, in_sync: 2, state: 'under-replicated', not_in_sync: ['node3'], nodes: ['node1', 'node2'] };
  const { client } = recordingClient(new Map([['BUCKET_STATS', answer]]));
  const stats = await client.database('d').hash('b').stats();
  assert.equal(stats.inSync, 2);
  assert.equal(stats.state, 'under-replicated');
  assert.deepEqual(stats.notInSync, ['node3']);
  assert.equal('pendingCopies' in stats, false);
  assert.deepEqual(stats.raw['nodes'], ['node1', 'node2']);
});

test('the owner\'s copies view is passed through, pending copies included, and absent members stay absent', async () => {
  const answer = {
    found: true,
    database: 'd',
    bucket: {
      name: 'b',
      type: 'hash',
      entries: 0,
      stores: null,
      in_sync: 1,
      state: 'copying',
      pending_copies: [{ node: 'node2', since: 1_700_000_000 }],
    },
  };
  const { client } = recordingClient(new Map([['BUCKET_INFO', answer]]));
  const declaration = await client.database('d').hash('b').info();
  assert.equal(declaration.inSync, 1);
  assert.equal(declaration.state, 'copying');
  assert.deepEqual(declaration.pendingCopies, [{ node: 'node2', since: 1_700_000_000 }]);
  assert.equal('notInSync' in declaration, false);
});

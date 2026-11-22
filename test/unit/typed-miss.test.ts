// SPDX-License-Identifier: Apache-2.0
//
// The miss rule (all drivers match): a verb that returns a list answers an
// empty array when there is nothing and never throws for emptiness; a verb that returns one value
// throws NotFoundError on a miss, so a miss and a stored null are never confused. Each answer is a
// frozen vector's own.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { NotFoundError } from '../../src/errors.js';
import { answerTo, recordingClient } from '../helpers/recording.js';
import { vectorNamed } from '../helpers/vectors.js';
import type { OpName } from '../../src/wire/opcodes.js';

async function assertNotFound(promise: Promise<unknown>, verb: string): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof NotFoundError, `${verb} throws NotFoundError, got ${String(error)}`);
    assert.equal(error.code, 'NOT_FOUND', verb);
    assert.equal(error.operation, verb);
    return true;
  });
}

test('get of a missing key throws NotFoundError', async () => {
  const { client } = recordingClient(answerTo(vectorNamed('get of a key that does not exist')));
  await assertNotFound(client.database('v085').hash('users').get('nobody'), 'get');
});

test('btree first and last of an empty tree throw NotFoundError', async () => {
  const empty = answerTo(vectorNamed('btree first of an empty bucket'));
  const { client } = recordingClient(
    new Map([
      ['BTREE_FIRST' as OpName, [...empty.values()][0] ?? {}],
      ['BTREE_LAST' as OpName, [...empty.values()][0] ?? {}],
    ]),
  );
  const tree = client.database('v094').btree('b');
  await assertNotFound(tree.first(), 'first');
  await assertNotFound(tree.last(), 'last');
});

test('findOne with no match throws NotFoundError', async () => {
  const { client } = recordingClient(new Map([['SCAN' as OpName, { found: true, documents: [], total: 0n, has_more: false }]]));
  await assertNotFound(client.database('app').hash('users').findOne({ Name: 'nobody' }), 'findOne');
});

test('update of a missing key throws NotFoundError', async () => {
  const { client } = recordingClient(answerTo(vectorNamed('update of a key that does not exist')));
  await assertNotFound(client.database('v').hash('users').update('nobody', { $set: { Name: 'x' } }), 'update');
});

test('getBlob of a missing key throws NotFoundError', async () => {
  const { client } = recordingClient(answerTo(vectorNamed('blob read of a key that does not exist')));
  await assertNotFound(client.database('v096').blob('files').getBlob('nothing.txt'), 'getBlob');
});

test('a field get of a missing element, and a field getBlob of one, throw NotFoundError', async () => {
  const { client } = recordingClient(answerTo(vectorNamed('field get of an element that does not exist')));
  const friends = client.database('v124').hash('User').field('ada', 'Friends');
  await assertNotFound(friends.get('carol'), 'get');
  await assertNotFound(friends.getBlob('carol'), 'getBlob');
});

test('a stored null field is a found document, not a miss', async () => {
  const { client } = recordingClient(new Map([['GET' as OpName, { found: true, data: { _id_: 'k', Nick: null } }]]));
  const stored = await client.database('app').hash('users').get('k');
  assert.ok(stored !== null);
  assert.equal(stored['Nick'], null);
});

test('list verbs answer an empty array on an empty result and never throw', async () => {
  const peekEmpty = [...answerTo(vectorNamed('fifo peek of an empty queue')).values()][0] ?? {};
  const popEmpty = [...answerTo(vectorNamed('fifo pop of an empty queue')).values()][0] ?? {};
  const heapEmpty = [...answerTo(vectorNamed('heap pop of an empty heap')).values()][0] ?? {};
  const fieldEmpty = [...answerTo(vectorNamed('field pop on an empty fifo store field')).values()][0] ?? {};
  const { client } = recordingClient(
    new Map([
      ['FIFO_PEEK' as OpName, peekEmpty],
      ['FIFO_POP' as OpName, popEmpty],
      ['FIELD_POP' as OpName, fieldEmpty],
      ['FIELD_PEEK' as OpName, { found: false }],
    ]),
  );
  const queue = client.database('v').fifo('q');
  assert.deepEqual(await queue.peek(), []);
  assert.deepEqual(await queue.pop(), []);
  assert.deepEqual(await client.database('v').heap('h').pop(), []);
  void heapEmpty;
  const store = client.database('v').hash('User').field('ada', 'Purchases');
  assert.deepEqual(await store.pop(), []);
  assert.deepEqual(await store.peek(), []);
});

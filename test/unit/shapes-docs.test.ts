// SPDX-License-Identifier: Apache-2.0
//
// The keyed, queue and heap verbs, checked against the frozen vectors: each call is made on a recording
// client, the request it produces must match the vector's request, and the result must be read from the
// vector's own answer. A miss is null or an empty list; a refusal is InvalidArgumentError with the
// server's sentence (build doc step 12).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { extendedJsonFromBytes } from '../../src/codec/index.js';
import { InvalidArgumentError, NotFoundError } from '../../src/errors.js';
import type { Stored } from '../../src/types.js';
import { assertRequestMatches } from '../helpers/compare.js';
import { answerTo, assertSentAs, recordingClient } from '../helpers/recording.js';
import { vectorNamed } from '../helpers/vectors.js';

const ADA = { Born: 1815, Name: 'Ada' };

test('put on a hash bucket matches its vector', async () => {
  const vector = vectorNamed('put on a hash bucket');
  const { client, sent } = recordingClient(answerTo(vector));
  const written = await client.database('v049').hash('users').put('ada', ADA);
  assertSentAs(sent[0], vector);
  assert.equal(written.id, 'ada');
});

test('put on a btree bucket matches its vector', async () => {
  const vector = vectorNamed('put on a btree bucket');
  const { client, sent } = recordingClient(answerTo(vector));
  await client.database('v050').btree('b').put('ada', ADA);
  assertSentAs(sent[0], vector);
});

test('insert without a key sends an empty key and the server assigns it', async () => {
  const vector = vectorNamed('insert without a key: the server assigns it');
  const { client, sent } = recordingClient(answerTo(vector));
  const written = await client.database('v051').hash('users').insert(ADA);
  assertSentAs(sent[0], vector);
  assert.equal(typeof written.id, 'string');
});

test('put with a write concern sends writeconcern', async () => {
  const vector = vectorNamed('put with a write concern');
  const { client, sent } = recordingClient(answerTo(vector));
  await client.database('v052').hash('users').put('ada', ADA, { writeConcern: 'majority' });
  assertSentAs(sent[0], vector);
});

test('get on a hash bucket returns the document', async () => {
  const vector = vectorNamed('get on a hash bucket');
  const { client, sent } = recordingClient(answerTo(vector));
  const found = await client.database('v084').hash('users').get('ada');
  assertSentAs(sent[0], vector);
  assert.equal(found?.Name, 'Ada');
  assert.equal(found?._id_, 'ada');
});

test('get of a key that does not exist throws NotFoundError', async () => {
  const vector = vectorNamed('get of a key that does not exist');
  const { client, sent } = recordingClient(answerTo(vector));
  await assert.rejects(client.database('v085').hash('users').get('nobody'), NotFoundError);
  assertSentAs(sent[0], vector);
});

test('get on a fifo bucket is an InvalidArgumentError with the server sentence', async () => {
  const vector = vectorNamed('get on a fifo bucket');
  const expected = (vector['response'] as { payload_json: { message: string } }).payload_json.message;
  const { client, sent } = recordingClient(answerTo(vector));
  await assert.rejects(
    client.database('v136').bucket('q').get('ada'),
    (error: unknown) => error instanceof InvalidArgumentError && error.message === expected,
  );
  assertSentAs(sent[0], vector);
});

test('delete of a key returns true, and of a missing key returns false', async () => {
  const present = vectorNamed('delete');
  const first = recordingClient(answerTo(present));
  assert.equal(await first.client.database('v061').hash('users').delete('ada'), true);
  assertSentAs(first.sent[0], present);

  const missing = vectorNamed('delete of a key that does not exist');
  const second = recordingClient(answerTo(missing));
  assert.equal(await second.client.database('v062').hash('users').delete('nobody'), false);
  assertSentAs(second.sent[0], missing);
});

test('fifo push and heap push (priority 5) match their vectors', async () => {
  const fifoPush = vectorNamed('fifo push');
  const fifo = recordingClient(answerTo(fifoPush));
  const queued = await fifo.client.database('v065').fifo('q').push(ADA);
  assertSentAs(fifo.sent[0], fifoPush);
  assert.equal(typeof queued.id, 'string');

  // The heap's opcode is the fifo family's (decision D-11); its fields are the heap push vector's.
  const heapPush = vectorNamed('heap push');
  const fifoFamily = vectorNamed('push on a heap bucket with the fifo family');
  const heap = recordingClient(answerTo(fifoFamily));
  await heap.client.database('v076').heap('h').push(ADA, { priority: 5 });
  const [sent] = heap.sent;
  assert.ok(sent !== undefined);
  assert.equal(sent.op, (fifoFamily['request'] as { opcode_name: string }).opcode_name);
  assertRequestMatches(
    extendedJsonFromBytes(sent.bytes),
    (heapPush['request'] as { payload_json: Record<string, unknown> }).payload_json,
    (heapPush['request'] as { allowed_fields: string[] }).allowed_fields,
  );
});

test('fifo pop returns a list of one document, and of an empty queue returns []', async () => {
  const pop = vectorNamed('fifo pop');
  const full = recordingClient(answerTo(pop));
  const item = await full.client.database('v066').fifo('q').pop();
  assertSentAs(full.sent[0], pop);
  assert.equal(item[0]?.Name, 'Ada');

  const empty = vectorNamed('fifo pop of an empty queue');
  const none = recordingClient(answerTo(empty));
  assert.deepEqual(await none.client.database('v067').fifo('q').pop(), []);
  assertSentAs(none.sent[0], empty);
});

test('fifo peek returns one item, and of an empty queue returns []', async () => {
  const peek = vectorNamed('fifo peek');
  const full = recordingClient(answerTo(peek));
  const items: Stored<Record<string, unknown>>[] = await full.client.database('v068').fifo('q').peek();
  assertSentAs(full.sent[0], peek);
  assert.equal(items.length, 1);
  assert.equal(items[0]?.Name, 'Ada');

  const empty = vectorNamed('fifo peek of an empty queue');
  const none = recordingClient(answerTo(empty));
  assert.deepEqual(await none.client.database('v069').fifo('q').peek(), []);
  assertSentAs(none.sent[0], empty);
});

test('get with consistent: true sends CONSISTENT_GET', async () => {
  const vector = vectorNamed('consistent get on one node');
  const { client, sent } = recordingClient(answerTo(vector));
  const found = await client.database('v097').hash('users').get('ada', { consistent: true });
  assertSentAs(sent[0], vector);
  assert.equal(found?.Name, 'Ada');
});

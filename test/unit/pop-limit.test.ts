// SPDX-License-Identifier: Apache-2.0
//
// pop({ limit }): one request removes up to `limit` entries and answers a list, in pop order, for a
// bucket and for a store field. Each call is made on a recording client and its request must match the
// frozen vector; the result is read from the vector's own answer (handbook operations.md, pop).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { InvalidArgumentError } from '../../src/errors.js';
import { answerTo, assertSentAs, recordingClient } from '../helpers/recording.js';
import { vectorNamed } from '../helpers/vectors.js';

test('pop with a limit returns that many documents, in pop order', async () => {
  const vector = vectorNamed('fifo pop with a limit');
  const { client, sent } = recordingClient(answerTo(vector));
  const taken = await client.database('v190').fifo('q').pop({ limit: 2 });
  assertSentAs(sent[0], vector);
  assert.deepEqual(
    taken.map((document) => document['Name']),
    ['Ada', 'Grace'],
  );
});

test('pop with a limit past the end returns what there was', async () => {
  const vector = vectorNamed('fifo pop with a limit past the end');
  const { client, sent } = recordingClient(answerTo(vector));
  const taken = await client.database('v191').fifo('q').pop({ limit: 5 });
  assertSentAs(sent[0], vector);
  assert.equal(taken.length, 2);
});

test('pop on a lifo and on a heap takes a limit too, over the fifo family', async () => {
  // The driver sends the FIFO_* family to every store type (decision D-11), so the lifo and heap
  // vectors' answers are served to FIFO_POP; their payloads are what the server sends back.
  for (const [name, store, expected] of [
    ['lifo pop with a limit', 'lifo', ['Ada', 'Grace']],
    ['heap pop with a limit', 'heap', ['Grace', 'Linus']],
  ] as const) {
    const vector = vectorNamed(name);
    const asFifo = new Map([['FIFO_POP' as const, [...answerTo(vector).values()][0] ?? {}]]);
    const { client, sent } = recordingClient(asFifo);
    const queue = store === 'lifo' ? client.database('v').lifo('s') : client.database('v').heap('h');
    const taken = await queue.pop({ limit: 2 });
    const request = vector['request'] as { payload_json: { limit: { $numberInt: string } } };
    assert.equal(sent[0]?.op, 'FIFO_POP');
    assert.equal(sent[0]?.fields['limit'], Number(request.payload_json.limit.$numberInt), name);
    assert.equal(taken.length, expected.length, name);
    assert.equal(taken[0]?.['Name'] === undefined, false);
  }
});

test('pop without a limit sends none and returns a list of one', async () => {
  const vector = vectorNamed('fifo pop');
  const { client, sent } = recordingClient(answerTo(vector));
  const taken = await client.database('v066').fifo('q').pop();
  assertSentAs(sent[0], vector);
  assert.equal('limit' in (sent[0]?.fields ?? {}), false, 'the default is the server default: no limit on the wire');
  assert.equal(taken.length, 1);
  assert.equal(taken[0]?.Name, 'Ada');
});

test('pop of an empty queue returns an empty list', async () => {
  const vector = vectorNamed('fifo pop of an empty queue');
  const { client, sent } = recordingClient(answerTo(vector));
  assert.deepEqual(await client.database('v067').fifo('q').pop({ limit: 3 }), []);
  assert.equal(sent[0]?.fields['limit'], 3);
});

test('a field store pop takes a limit and returns its entries', async () => {
  const vector = vectorNamed('field pop with a limit on a fifo store field');
  const { client, sent } = recordingClient(answerTo(vector));
  const taken = await client.database('v196').hash('User').field('ada', 'Purchases').pop({ limit: 2 });
  assertSentAs(sent[0], vector);
  assert.deepEqual(
    taken.map((entry) => (entry.element as { Item: string }).Item),
    ['tea', 'scones'],
  );
});

test('a field store pop of nothing returns an empty list', async () => {
  const vector = vectorNamed('field pop on an empty fifo store field');
  const { client } = recordingClient(answerTo(vector));
  assert.deepEqual(await client.database('v119').hash('User').field('ada', 'Purchases').pop(), []);
});

test('a limit outside 1 to 100 is refused before anything is sent, as the server would refuse it', async () => {
  const vector = vectorNamed('pop limit above the maximum');
  assert.equal((vector['error'] as { name: string }).name, 'INVALID_ARGUMENT');
  const { client, sent } = recordingClient(answerTo(vector));
  const queue = client.database('v194').fifo('q');
  for (const limit of [0, -1, 101, 2.5, Number.NaN]) {
    await assert.rejects(queue.pop({ limit }), (error: InvalidArgumentError) => {
      assert.ok(error instanceof InvalidArgumentError);
      assert.equal(error.writeOutcome, 'not_applied');
      assert.match(error.message, /pop limit must be a whole number from 1 to 100/);
      return true;
    });
  }
  const field = client.database('v194').hash('User').field('ada', 'Purchases');
  await assert.rejects(field.pop({ limit: 101 }), InvalidArgumentError);
  assert.equal(sent.length, 0, 'nothing reached the server');
});

test('the server refusal of a limit above 100 reaches the caller with its wording', async () => {
  const vector = vectorNamed('pop limit above the maximum');
  const message = (vector['response'] as { payload_json: { message: string } }).payload_json.message;
  const { client } = recordingClient(
    new Map([
      [
        'FIFO_POP',
        () => {
          throw new InvalidArgumentError({ message, operation: 'pop', writeOutcome: 'not_applied' });
        },
      ],
    ]),
  );
  // 100 passes the local bound; the server's own refusal (a lowered operator cap) is passed through.
  await assert.rejects(client.database('v194').fifo('q').pop({ limit: 100 }), /101 is above the pop maximum of 100/);
});

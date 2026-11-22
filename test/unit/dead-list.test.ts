// SPDX-License-Identifier: Apache-2.0
//
// deadList, requeue and discard (handbook operations.md "Leases and the dead list"). The requests are
// checked against the frozen vectors; an answer that carries entries is built by hand, because the
// vectors capture a bucket with none. An empty dead list is an empty page and no error (a list verb never reports emptiness as an error).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ConnectionError, DeadMoveRefusedError, InvalidArgumentError, isHoardDBError } from '../../src/errors.js';
import type { OpName } from '../../src/wire/opcodes.js';
import { answerTo, assertSentAs, recordingClient, type AnswerFrom } from '../helpers/recording.js';
import { vectorNamed } from '../helpers/vectors.js';

async function refusalOf(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
  } catch (error) {
    return error;
  }
  throw new Error('the call resolved; it should have been refused');
}

const DIED = new Date('2026-10-20T08:00:00.000Z');

const ENTRIES = {
  found: true,
  items: [
    { dead_id: '0000000000000000', data: { Name: 'Ada' }, deliveries: 5n, dead_at: DIED, reason: 'max_deliveries' },
    { dead_id: '0000000000000001', data: { Name: 'Grace' }, deliveries: 5n, dead_at: DIED, reason: 'collided' },
  ],
  next: '0000000000000001',
  message: '',
};

// ---- deadList --------------------------------------------------------------------------------

test('deadList of a bucket with none is an empty page, not an error', async () => {
  const vector = vectorNamed('dead list of a bucket with none');
  const { client, sent } = recordingClient(answerTo(vector));
  const page = await client.database('v207').fifo('q').deadList();
  assertSentAs(sent[0], vector);
  assert.deepEqual(page.items, []);
  assert.equal(page.next, undefined);
  assert.equal('limit' in (sent[0]?.fields ?? {}), false, 'the server default is 10: no limit on the wire');
});

test('deadList reads entries and the cursor to the next page', async () => {
  const { client, sent } = recordingClient(new Map([['DEAD_LIST' as OpName, ENTRIES]]));
  const page = await client.database('v').fifo('q').deadList({ limit: 2, after: '0000000000000000' });
  assert.equal(sent[0]?.op, 'DEAD_LIST');
  assert.equal(sent[0]?.fields['limit'], 2);
  assert.equal(sent[0]?.fields['after'], '0000000000000000');
  assert.equal(page.next, '0000000000000001');
  assert.equal(page.items.length, 2);
  const [first, second] = page.items;
  assert.equal(first?.deadId, '0000000000000000');
  assert.deepEqual(first?.document, { Name: 'Ada' });
  assert.equal(first?.deliveries, 5);
  assert.equal(first?.reason, 'max_deliveries');
  assert.equal(first?.deadAt.toISOString(), DIED.toISOString());
  assert.equal(second?.reason, 'collided');
});

test('the last page has no next', async () => {
  const { client } = recordingClient(new Map([['DEAD_LIST' as OpName, { ...ENTRIES, next: undefined }]]));
  const page = await client.database('v').fifo('q').deadList();
  assert.equal(page.items.length, 2);
  assert.equal(page.next, undefined);
});

test('an empty dead page is not an error, whether the server says found true or found false', async () => {
  for (const answer of [{ found: true, items: [], message: '' }, { found: true, message: '' }, { found: false, message: '' }, { found: false }]) {
    const { client } = recordingClient(new Map([['DEAD_LIST' as OpName, answer]]));
    const page = await client.database('v').fifo('q').deadList();
    assert.deepEqual(page.items, [], JSON.stringify(answer));
    assert.equal(page.next, undefined);
  }
});

test('a next of the empty string under found true means no next page', async () => {
  const { client } = recordingClient(new Map([['DEAD_LIST' as OpName, { ...ENTRIES, next: '' }]]));
  const page = await client.database('v').fifo('q').deadList();
  assert.equal(page.items.length, 2);
  assert.equal(page.next, undefined);
  assert.equal('next' in page, false, 'the key is absent, not undefined');
});

test('found:false with a message is a refusal, never "no dead entries"', async () => {
  const { client } = recordingClient(new Map([['DEAD_LIST' as OpName, { found: false, message: 'dead is not defined for hash buckets' }]]));
  const error = await refusalOf(() => client.database('v').bucket('h').deadList());
  assert.ok(error instanceof InvalidArgumentError);
  assert.equal(error.message, 'dead is not defined for hash buckets');
});

test('a dead list limit outside 1 to 1000 is refused before anything is sent', async () => {
  const { client, sent } = recordingClient(new Map([['DEAD_LIST' as OpName, ENTRIES]]));
  const queue = client.database('v').fifo('q');
  for (const limit of [0, 1001, 1.5, -1]) {
    assert.ok((await refusalOf(() => queue.deadList({ limit }))) instanceof InvalidArgumentError, String(limit));
  }
  assert.equal(sent.length, 0);
  await queue.deadList({ limit: 1000 });
  assert.equal(sent.length, 1);
});

test('deadList is a read: a lost connection is retried once on a fresh connection', async () => {
  let attempts = 0;
  const flaky: AnswerFrom = () => {
    attempts += 1;
    if (attempts === 1) throw new ConnectionError({ message: 'The connection failed during dead list (reset).', operation: 'deadList' });
    return ENTRIES;
  };
  const { client, sent } = recordingClient(new Map<OpName, AnswerFrom>([['DEAD_LIST', flaky]]));
  const page = await client.database('v').fifo('q').deadList();
  assert.equal(sent.length, 2, 'the read was sent twice');
  assert.equal(page.items.length, 2);
});

// ---- requeue and discard ---------------------------------------------------------------------

test('requeue of one dead id with no such entry throws DeadMoveRefusedError carrying the result', async () => {
  const vector = vectorNamed('requeue with no dead entry');
  const { client, sent } = recordingClient(answerTo(vector));
  const error = await refusalOf(() => client.database('v208').fifo('q').requeue({ byId: '0000000000000000' }));
  assertSentAs(sent[0], vector);
  assert.ok(error instanceof DeadMoveRefusedError);
  assert.ok(error instanceof InvalidArgumentError);
  assert.equal(error.result.done, 0);
  assert.equal(error.result.refused.length, 1);
  assert.equal(error.result.refused[0]?.deadId, '0000000000000000');
  assert.match(error.result.refused[0]?.message ?? '', /no dead entry "0000000000000000"/);
  assert.equal(error.message, error.result.refused[0]?.message, 'with no message of its own the refusals are the message');
});

test('discard of all, with none, moves nothing and succeeds', async () => {
  const vector = vectorNamed('discard all of none');
  const { client, sent } = recordingClient(answerTo(vector));
  const result = await client.database('v209').fifo('q').discard({ all: true });
  assertSentAs(sent[0], vector);
  assert.deepEqual(result, { done: 0, left: 0, refused: [], message: '' });
});

test('requeue and discard of all after a dead id send after and read done, left and the message', async () => {
  for (const [name, verb, database] of [
    ['requeue all after a dead id', 'requeue', 'v239'],
    ['discard all after a dead id', 'discard', 'v240'],
  ] as const) {
    const vector = vectorNamed(name);
    const { client, sent } = recordingClient(answerTo(vector));
    const queue = client.database(database).fifo('q');
    const result = await queue[verb]({ all: true, after: '0000000000000000' });
    assertSentAs(sent[0], vector);
    assert.equal(result.done, 1, name);
    assert.equal(result.left, 1, name);
    assert.match(result.message, /1 dead entries are left/, name);
  }
});

test('requeue and discard use their own opcodes', async () => {
  const answer = { success: true, done: 1n };
  const { client, sent } = recordingClient(
    new Map<OpName, Record<string, unknown>>([
      ['DEAD_REQUEUE', answer],
      ['DEAD_DISCARD', answer],
    ]),
  );
  const queue = client.database('v').fifo('q');
  await queue.requeue({ byId: 'a' });
  await queue.discard({ byId: 'a' });
  assert.deepEqual(
    sent.map((request) => request.op),
    ['DEAD_REQUEUE', 'DEAD_DISCARD'],
  );
});

test('an after on a single-entry selector is sent for the server to refuse, as the vector does', async () => {
  const vector = vectorNamed('requeue of one dead id with after');
  const { client, sent } = recordingClient(
    new Map<OpName, AnswerFrom>([
      [
        'DEAD_REQUEUE',
        () => {
          throw new InvalidArgumentError({ message: 'invalid dead option: requeue\'s after pages an all request', operation: 'requeue', writeOutcome: 'not_applied' });
        },
      ],
    ]),
  );
  const error = await refusalOf(() => client.database('v241').fifo('q').requeue({ byId: '0000000000000000', after: '0000000000000000' }));
  assertSentAs(sent[0], vector);
  assert.ok(error instanceof InvalidArgumentError);
});

test('a refusal of part of an all request keeps what moved and names what stayed', async () => {
  const answer = {
    success: false,
    done: 3n,
    left: 1n,
    refused: [{ dead_id: '0000000000000009', message: 'a live element holds the key "x"' }],
    message: '',
  };
  const { client } = recordingClient(new Map([['DEAD_REQUEUE' as OpName, answer]]));
  const error = await refusalOf(() => client.database('v').heap('h').requeue({ all: true }));
  assert.ok(error instanceof DeadMoveRefusedError);
  assert.equal(error.result.done, 3);
  assert.equal(error.result.left, 1);
  assert.deepEqual(error.result.refused, [{ deadId: '0000000000000009', message: 'a live element holds the key "x"' }]);
});

test('a selector must name one dead id or all, and nothing is sent otherwise', async () => {
  const { client, sent } = recordingClient(new Map([['DEAD_REQUEUE' as OpName, { success: true, done: 0n }]]));
  const queue = client.database('v').fifo('q');
  for (const [label, selector] of [
    ['neither', {}],
    ['both', { byId: 'a', all: true }],
    ['an empty dead id', { byId: '' }],
    ['all: false', { all: false }],
  ] as const) {
    const error = await refusalOf(() => queue.requeue(selector as never));
    assert.ok(error instanceof InvalidArgumentError, label);
    assert.equal(error.writeOutcome, 'not_applied', label);
  }
  assert.equal(sent.length, 0);
});

test('requeue and discard are never resent after a lost answer', async () => {
  const lost = (): never => {
    throw new ConnectionError({ message: 'The connection failed during requeue (reset).', operation: 'requeue' });
  };
  for (const [verb, op] of [
    ['requeue', 'DEAD_REQUEUE'],
    ['discard', 'DEAD_DISCARD'],
  ] as const) {
    const { client, sent } = recordingClient(new Map<OpName, AnswerFrom>([[op, lost]]));
    const error = await refusalOf(() => client.database('v').fifo('q')[verb]({ all: true }));
    assert.ok(isHoardDBError(error), verb);
    assert.equal(error.writeOutcome, 'unknown', verb);
    assert.equal(sent.length, 1, `${verb} was sent once`);
  }
});

test('requeue and discard carry a write concern', async () => {
  const { client, sent } = recordingClient(new Map([['DEAD_DISCARD' as OpName, { success: true, done: 0n }]]));
  await client.database('v').fifo('q').discard({ all: true }, { writeConcern: 'all' });
  assert.equal(sent[0]?.fields['writeconcern'], 'all');
});

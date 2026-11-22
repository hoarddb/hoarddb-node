// SPDX-License-Identifier: Apache-2.0
//
// claim, ack, release and extend on a bucket (handbook operations.md "Leases and the dead list",
// errors.md sections 3 and 6). Each call is made on a recording client: its request must match the
// frozen vector, and the result is read from the vector's own answer (a vector's normalised lease id
// is replaced by a real one first). Failing-first: every test here fails against the stubs.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  ClaimEntryTooLargeError,
  ConnectionError,
  InternalError,
  InvalidArgumentError,
  LeaseExpiredError,
  LeaseUnknownError,
  isHoardDBError,
} from '../../src/errors.js';
import type { OpName } from '../../src/wire/opcodes.js';
import { answerTo, assertSentAs, recordingClient, type AnswerFrom } from '../helpers/recording.js';
import { LEASE, assertSentWithLease, claimAnswer, leaseAnswer } from '../helpers/leases.js';
import { vectorNamed } from '../helpers/vectors.js';

/** The vector's answer for `op` with its normalised lease id made a real one. */
function answersOf(name: string, op: OpName): Map<OpName, Record<string, unknown>> {
  const [answer] = [...answerTo(vectorNamed(name)).values()];
  const withLease = answer?.['lease_id'] === 'normalised' ? { ...answer, lease_id: LEASE } : (answer ?? {});
  return new Map([[op, withLease]]);
}

async function refusalOf(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
  } catch (error) {
    return error;
  }
  throw new Error('the call resolved; it should have been refused');
}

// ---- claim -----------------------------------------------------------------------------------

test('claim sends limit and lease as the vector does and reads the parallel lists', async () => {
  const vector = vectorNamed('fifo claim');
  const { client, sent } = recordingClient(answersOf('fifo claim', 'QUEUE_CLAIM'));
  const claimed = await client.database('v197').fifo('fifo').claim({ limit: 2, lease: 60_000 });
  assertSentAs(sent[0], vector);
  assert.equal(claimed.leaseId, LEASE);
  assert.equal(claimed.grantedMs, 60_000);
  assert.equal(claimed.pending, 2);
  assert.equal(claimed.dead, 0);
  assert.equal(claimed.returned, 0);
  assert.deepEqual(
    claimed.items.map((delivery) => [delivery.itemId, delivery.document['Name'], delivery.deliveries]),
    [
      ['0000000000000000', 'Ada', 1],
      ['0000000000000001', 'Grace', 1],
    ],
  );
});

test('claim on a lifo and on a heap sends the same opcode, as the vectors show', async () => {
  for (const [name, store, db] of [
    ['lifo claim', 'lifo', 'v198'],
    ['heap claim', 'heap', 'v199'],
  ] as const) {
    const vector = vectorNamed(name);
    const { client, sent } = recordingClient(answersOf(name, 'QUEUE_CLAIM'));
    const database = client.database(db);
    const claimed = await (store === 'lifo' ? database.lifo('lifo') : database.heap('heap')).claim({ limit: 2, lease: 60_000 });
    assertSentAs(sent[0], vector);
    assert.equal(claimed.items.length, 2, name);
    assert.equal(claimed.items[0]?.document['Name'], 'Linus', `${name}: pop order, newest first`);
  }
});

test('a delivery count above 1 is carried; an absent count is 1', async () => {
  const vector = vectorNamed('claim with a redelivery');
  const { client, sent } = recordingClient(answersOf('claim with a redelivery', 'QUEUE_CLAIM'));
  const claimed = await client.database('v201').fifo('q').claim({ limit: 1 });
  assertSentAs(sent[0], vector);
  assert.equal(claimed.items[0]?.deliveries, 2);
  assert.equal(claimed.grantedMs, 30_000);

  const plain = recordingClient(new Map([['QUEUE_CLAIM' as OpName, claimAnswer(2)]]));
  const first = await plain.client.database('v').fifo('q').claim();
  assert.deepEqual(first.items.map((delivery) => delivery.deliveries), [1, 1]);
});

test('claim without options sends neither limit nor lease: the server defaults are 1 and 30 s', async () => {
  const { client, sent } = recordingClient(new Map([['QUEUE_CLAIM' as OpName, claimAnswer(1)]]));
  await client.database('v').fifo('q').claim();
  assert.equal('limit' in (sent[0]?.fields ?? {}), false);
  assert.equal('lease_ms' in (sent[0]?.fields ?? {}), false);
});

test('claim of an empty queue is an empty Claimed, not an error', async () => {
  const vector = vectorNamed('claim of an empty queue');
  const { client, sent } = recordingClient(answerTo(vector));
  const claimed = await client.database('v200').fifo('q').claim({ limit: 1 });
  assertSentAs(sent[0], vector);
  assert.deepEqual(claimed.items, []);
  assert.equal(claimed.returned, 0);
});

test('a claim that returned expired leases and took nothing says so and is not an error', async () => {
  const { client } = recordingClient(new Map([['QUEUE_CLAIM' as OpName, { found: false, returned: 2n, pending: 1n, dead: 1n, message: '' }]]));
  const claimed = await client.database('v').fifo('q').claim();
  assert.deepEqual(claimed.items, []);
  assert.equal(claimed.returned, 2);
  assert.equal(claimed.pending, 1);
  assert.equal(claimed.dead, 1);
});

test('claim on a hash bucket is refused with the server sentence verbatim', async () => {
  const vector = vectorNamed('claim on a hash bucket');
  const { client, sent } = recordingClient(answerTo(vector));
  const error = await refusalOf(() => client.database('v217').bucket('h').claim({ limit: 1 }));
  assertSentAs(sent[0], vector);
  assert.ok(error instanceof InvalidArgumentError);
  assert.ok(!(error instanceof ClaimEntryTooLargeError));
  assert.equal(error.message, (vector['response'] as { payload_json: { message: string } }).payload_json.message);
});

test('claim options outside their range are refused before anything is sent', async () => {
  const { client, sent } = recordingClient(new Map([['QUEUE_CLAIM' as OpName, claimAnswer(1)]]));
  const queue = client.database('v').fifo('q');
  const bad: [string, { limit?: number; lease?: number }][] = [
    ['limit 0', { limit: 0 }],
    ['limit 101', { limit: 101 }],
    ['limit 1.5', { limit: 1.5 }],
    ['lease 999', { lease: 999 }],
    ['lease 3600001', { lease: 3_600_001 }],
    ['lease 1.5', { lease: 1.5 }],
  ];
  for (const [label, opts] of bad) {
    const error = await refusalOf(() => queue.claim(opts));
    assert.ok(error instanceof InvalidArgumentError, label);
    assert.equal(error.writeOutcome, 'not_applied', label);
  }
  assert.equal(sent.length, 0, 'nothing was sent');
  await queue.claim({ limit: 100, lease: 3_600_000 });
  await queue.claim({ limit: 1, lease: 1_000 });
  assert.equal(sent.length, 2, 'the bounds themselves are allowed');
});

test('a claim of an entry over the hard cap is ClaimEntryTooLargeError, and also an InvalidArgumentError', async () => {
  const sentence = 'claim refused: the entry at the front of the queue is 5242880 bytes, over the 4970000 a claim moves. Pop it with pop()';
  const { client } = recordingClient(
    new Map<OpName, AnswerFrom>([
      [
        'QUEUE_CLAIM',
        () => {
          throw new InvalidArgumentError({ message: sentence, operation: 'claim', writeOutcome: 'not_applied' });
        },
      ],
    ]),
  );
  const error = await refusalOf(() => client.database('v').fifo('q').claim());
  assert.ok(error instanceof ClaimEntryTooLargeError);
  assert.ok(error instanceof InvalidArgumentError);
  assert.equal(error.code, 'INVALID_ARGUMENT');
  assert.equal(error.message, sentence);
  assert.match(error.hint ?? '', /pop\(\)/);
});

test('an INVALID_ARGUMENT that does not start "claim refused" is not the hard-cap error', async () => {
  const { client } = recordingClient(
    new Map<OpName, AnswerFrom>([
      [
        'QUEUE_CLAIM',
        () => {
          throw new InvalidArgumentError({ message: 'invalid claim limit: 101 is above the claim maximum of 100', operation: 'claim' });
        },
      ],
    ]),
  );
  const error = await refusalOf(() => client.database('v').fifo('q').claim());
  assert.ok(error instanceof InvalidArgumentError);
  assert.ok(!(error instanceof ClaimEntryTooLargeError));
  assert.equal(error.code, 'INVALID_ARGUMENT');
});

const CAP_SENTENCE = 'claim refused: the entry at the front of the queue is 5242880 bytes, over the 4970000 a claim moves.';

test('a refusal with the hard-cap sentence under another code is not the hard-cap error', async () => {
  const { client } = recordingClient(
    new Map<OpName, AnswerFrom>([
      [
        'QUEUE_CLAIM',
        () => {
          throw new InternalError({ message: CAP_SENTENCE, operation: 'claim' });
        },
      ],
    ]),
  );
  const error = await refusalOf(() => client.database('v').fifo('q').claim());
  assert.ok(error instanceof InternalError);
  assert.ok(!(error instanceof ClaimEntryTooLargeError));
});

test('an INVALID_ARGUMENT whose message starts "claim" but not "claim refused" is not the hard-cap error', async () => {
  for (const message of ['claim limit is out of range', 'claim rejected: the entry is too big', 'Claim refused: capital C']) {
    const { client } = recordingClient(
      new Map<OpName, AnswerFrom>([
        [
          'QUEUE_CLAIM',
          () => {
            throw new InvalidArgumentError({ message, operation: 'claim' });
          },
        ],
      ]),
    );
    const error = await refusalOf(() => client.database('v').fifo('q').claim());
    assert.ok(error instanceof InvalidArgumentError, message);
    assert.ok(!(error instanceof ClaimEntryTooLargeError), message);
    assert.equal(error.code, 'INVALID_ARGUMENT', message);
  }
});

test('a claim answer whose lease id is not 40 hexadecimal characters is refused, not misread', async () => {
  const badIds: unknown[] = ['not-a-lease', '', LEASE.slice(1), `${LEASE}0`, 'g'.repeat(40), 12345n, undefined];
  for (const leaseId of badIds) {
    const answer = { ...claimAnswer(1), lease_id: leaseId };
    const { client } = recordingClient(new Map([['QUEUE_CLAIM' as OpName, answer]]));
    const error = await refusalOf(() => client.database('v').fifo('q').claim());
    assert.ok(isHoardDBError(error), String(leaseId));
    assert.equal(error.code, 'PROTOCOL_ERROR', `lease id ${String(leaseId)}`);
  }
  const upper = recordingClient(new Map([['QUEUE_CLAIM' as OpName, { ...claimAnswer(1), lease_id: LEASE.toUpperCase() }]]));
  assert.equal((await upper.client.database('v').fifo('q').claim()).leaseId, LEASE, 'an upper-case id is read and lower-cased');
});

test('delivery.extend from a claim returns the length the server granted, not the one asked for', async () => {
  const { client, sent } = recordingClient(
    new Map<OpName, Record<string, unknown>>([
      ['QUEUE_CLAIM', claimAnswer(1)],
      ['QUEUE_EXTEND', leaseAnswer({ lease_state: 'extended', lease_ms: 45_000n })],
    ]),
  );
  const claimed = await client.database('v').fifo('q').claim();
  assert.equal(await claimed.items[0]?.extend(120_000), 45_000);
  const extend = sent.find((request) => request.op === 'QUEUE_EXTEND');
  assert.equal(extend?.fields['lease_ms'], 120_000, 'the asked-for length is what goes on the wire');
  assert.equal(extend?.fields['lease_id'], LEASE);
});

test('a claim carries a write concern like any write', async () => {
  const { client, sent } = recordingClient(new Map([['QUEUE_CLAIM' as OpName, claimAnswer(1)]]));
  await client.database('v').fifo('q').claim({ writeConcern: 'majority' });
  assert.equal(sent[0]?.fields['writeconcern'], 'majority');
});

test('a claim answer whose lists do not line up is refused, not misread', async () => {
  const skewed = { ...claimAnswer(2), item_ids: ['0000000000000000'] };
  const { client } = recordingClient(new Map([['QUEUE_CLAIM' as OpName, skewed]]));
  const error = await refusalOf(() => client.database('v').fifo('q').claim());
  assert.ok(isHoardDBError(error));
  assert.equal(error.code, 'PROTOCOL_ERROR');
});

// ---- ack -------------------------------------------------------------------------------------

test('ack of a whole lease names the lease and nothing else', async () => {
  const vector = vectorNamed('ack of a whole lease');
  const { client, sent } = recordingClient(answerTo(vector));
  const result = await client.database('v202').fifo('q').ack(LEASE);
  assertSentWithLease(sent[0], vector);
  assert.deepEqual(result, { state: 'acked', acked: 2, missing: 0, remaining: 0, message: '' });
});

test('ack with item ids sends them and reads acked, missing and remaining', async () => {
  const vector = vectorNamed('ack with item ids');
  const { client, sent } = recordingClient(answerTo(vector));
  const result = await client.database('v203').fifo('q').ack(LEASE, { itemIds: ['0000000000000000', '00000000000000ff'] });
  assertSentWithLease(sent[0], vector);
  assert.equal(result.acked, 1);
  assert.equal(result.missing, 1);
  assert.equal(result.remaining, 1);
});

test('ack of an unknown lease is LeaseUnknownError with the result beside it, never not_applied', async () => {
  const vector = vectorNamed('ack of an unknown lease');
  const { client, sent } = recordingClient(answerTo(vector));
  const error = await refusalOf(() => client.database('v204').fifo('q').ack('0123456789abcdef0123456789abcdef01234567'));
  assertSentAs(sent[0], vector);
  assert.ok(error instanceof LeaseUnknownError);
  assert.equal(error.code, 'LEASE_UNKNOWN');
  assert.ok(!(error instanceof InvalidArgumentError));
  assert.equal(error.message, (vector['response'] as { payload_json: { message: string } }).payload_json.message);
  assert.equal(error.result?.state, 'unknown');
  assert.equal(error.result?.message, error.message);
  assert.notEqual(error.writeOutcome, 'not_applied');
});

test('ack of an expired lease is LeaseExpiredError', async () => {
  const { client } = recordingClient(
    new Map([['QUEUE_ACK' as OpName, { success: false, lease_state: 'expired', message: 'lease 0123…67 expired 3s ago' }]]),
  );
  const error = await refusalOf(() => client.database('v').fifo('q').ack(LEASE));
  assert.ok(error instanceof LeaseExpiredError);
  assert.equal(error.code, 'LEASE_EXPIRED');
  assert.equal(error.result?.state, 'expired');
});

test('an in-band ack failure that is neither unknown nor expired is an InvalidArgumentError', async () => {
  const { client } = recordingClient(new Map([['QUEUE_ACK' as OpName, { success: false, message: 'ack is not defined for hash buckets' }]]));
  const error = await refusalOf(() => client.database('v').bucket('h').ack(LEASE));
  assert.ok(error instanceof InvalidArgumentError);
  assert.equal(error.message, 'ack is not defined for hash buckets');
});

test('ack arguments are checked before anything is sent', async () => {
  const { client, sent } = recordingClient(new Map([['QUEUE_ACK' as OpName, leaseAnswer({ lease_state: 'acked', acked: 1n })]]));
  const queue = client.database('v').fifo('q');
  const many = Array.from({ length: 101 }, (_, position) => String(position));
  for (const [label, run] of [
    ['a lease id that is not 40 hex characters', () => queue.ack('not-a-lease')],
    ['an empty lease id', () => queue.ack('')],
    ['an empty id list', () => queue.ack(LEASE, { itemIds: [] })],
    ['101 item ids', () => queue.ack(LEASE, { itemIds: many })],
  ] as const) {
    const error = await refusalOf(run);
    assert.ok(error instanceof InvalidArgumentError, label);
    assert.equal(error.writeOutcome, 'not_applied', label);
  }
  assert.equal(sent.length, 0, 'nothing was sent');
  await queue.ack(LEASE, { itemIds: many.slice(0, 100) });
  assert.equal(sent.length, 1, '100 ids are allowed');
});

test('an item id that is a document id is passed on: the server refuses it with its own sentence', async () => {
  const vector = vectorNamed('item id that is a document id');
  const { client, sent } = recordingClient(
    new Map<OpName, AnswerFrom>([
      [
        'QUEUE_ACK',
        () => {
          const message = (vector['response'] as { payload_json: { message: string } }).payload_json.message;
          throw new InvalidArgumentError({ message, operation: 'ack', writeOutcome: 'not_applied' });
        },
      ],
    ]),
  );
  const error = await refusalOf(() => client.database('v216').fifo('q').ack(LEASE, { itemIds: ['job-7'] }));
  assertSentWithLease(sent[0], vector);
  assert.ok(error instanceof InvalidArgumentError);
  assert.match(error.message, /item id "job-7" is not a handle claim returned/);
});

// ---- release ---------------------------------------------------------------------------------

test('release gives the entries back and reports how many', async () => {
  const vector = vectorNamed('release');
  const { client, sent } = recordingClient(answerTo(vector));
  const result = await client.database('v205').fifo('q').release(LEASE);
  assertSentWithLease(sent[0], vector);
  assert.deepEqual(result, { state: 'released', released: 2, message: '' });
});

test('release of an unknown or expired lease is the typed error with the result', async () => {
  for (const [state, ErrorClass] of [
    ['unknown', LeaseUnknownError],
    ['expired', LeaseExpiredError],
  ] as const) {
    const { client } = recordingClient(new Map([['QUEUE_RELEASE' as OpName, { success: false, lease_state: state, message: `the lease is ${state}` }]]));
    const error = await refusalOf(() => client.database('v').fifo('q').release(LEASE));
    assert.ok(error instanceof ErrorClass, state);
    assert.equal(error.result?.state, state);
    assert.equal('released' in (error.result ?? {}), true, 'the release result shape');
  }
});

test('release refuses a lease id that is not a lease id, sending nothing', async () => {
  const { client, sent } = recordingClient(new Map([['QUEUE_RELEASE' as OpName, leaseAnswer({ lease_state: 'released' })]]));
  const error = await refusalOf(() => client.database('v').fifo('q').release('xyz'));
  assert.ok(error instanceof InvalidArgumentError);
  assert.equal(sent.length, 0);
});

// ---- extend ----------------------------------------------------------------------------------

test('extend returns the length the server GRANTED, not the one asked for', async () => {
  const vector = vectorNamed('extend');
  const { client, sent } = recordingClient(answerTo(vector));
  assert.equal(await client.database('v206').fifo('q').extend(LEASE, 120_000), 120_000);
  assertSentWithLease(sent[0], vector);

  const shorter = recordingClient(new Map([['QUEUE_EXTEND' as OpName, leaseAnswer({ lease_state: 'extended', lease_ms: 45_000n })]]));
  assert.equal(await shorter.client.database('v').fifo('q').extend(LEASE, 120_000), 45_000);
});

test('extend of an unknown or expired lease is the typed error', async () => {
  for (const [state, ErrorClass] of [
    ['unknown', LeaseUnknownError],
    ['expired', LeaseExpiredError],
  ] as const) {
    const { client } = recordingClient(new Map([['QUEUE_EXTEND' as OpName, { success: false, lease_state: state, message: `the lease is ${state}` }]]));
    assert.ok((await refusalOf(() => client.database('v').fifo('q').extend(LEASE, 5_000))) instanceof ErrorClass, state);
  }
});

test('extend refuses a length outside 1 s to 1 h before anything is sent', async () => {
  const { client, sent } = recordingClient(new Map([['QUEUE_EXTEND' as OpName, leaseAnswer({ lease_state: 'extended', lease_ms: 1000n })]]));
  const queue = client.database('v').fifo('q');
  for (const ms of [999, 3_600_001, 0, 1.5, Number.NaN]) {
    assert.ok((await refusalOf(() => queue.extend(LEASE, ms))) instanceof InvalidArgumentError, String(ms));
  }
  assert.equal(sent.length, 0);
});

// ---- a lost answer is never resent ----------------------------------------------------------

test('claim, ack, release and extend are never resent after a lost answer', async () => {
  const lost = (): never => {
    throw new ConnectionError({ message: 'The connection to recording:7433 failed during claim (the server closed the connection).', operation: 'claim' });
  };
  const verbs: [string, OpName, (queue: ReturnType<ReturnType<ReturnType<typeof recordingClient>['client']['database']>['fifo']>) => Promise<unknown>][] = [
    ['claim', 'QUEUE_CLAIM', (queue) => queue.claim()],
    ['ack', 'QUEUE_ACK', (queue) => queue.ack(LEASE)],
    ['release', 'QUEUE_RELEASE', (queue) => queue.release(LEASE)],
    ['extend', 'QUEUE_EXTEND', (queue) => queue.extend(LEASE, 5_000)],
  ];
  for (const [name, op, run] of verbs) {
    const { client, sent } = recordingClient(new Map<OpName, AnswerFrom>([[op, lost]]));
    const error = await refusalOf(() => run(client.database('v').fifo('q')));
    assert.ok(isHoardDBError(error), name);
    assert.equal(error.code, 'CONNECTION_FAILED', name);
    assert.equal(error.writeOutcome, 'unknown', `${name}: the outcome is unknown`);
    assert.equal(error.retryable, false, name);
    assert.equal(sent.length, 1, `${name} was sent once`);
  }
});

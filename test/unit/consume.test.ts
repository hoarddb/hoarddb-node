// SPDX-License-Identifier: Apache-2.0
//
// consume: the claim, handle, ack loop with the exact semantics of the Go driver's Consume (handbook
// api-go.md section 5.2). The loop runs on a recording client, with the sleep and the randomness
// injected so the back-off is read from the delays it asks for rather than waited for.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { consumeLoop, backoffMs, handlerMarginMs, isTransient, defaultConsumeEnv, type ConsumeEnv } from '../../src/consume.js';
import {
  AbortedError,
  ClaimEntryTooLargeError,
  ConnectionError,
  InternalError,
  InvalidArgumentError,
  LeaseExpiredError,
  LeaseUnknownError,
  NotAuthenticatedError,
  NotFoundError,
  OverloadedError,
  PermissionDeniedError,
  PoolTimeoutError,
  RequestTimeoutError,
  UnavailableError,
  WriteConcernTimeoutError,
  type HoardDBError,
} from '../../src/errors.js';
import type { ConsumeHandler, Delivery, FifoBucket } from '../../src/types.js';
import type { OpName } from '../../src/wire/opcodes.js';
import { recordingClient, type AnswerFrom } from '../helpers/recording.js';
import { fakeEnv, queueWith, settled, stopAfter, within } from '../helpers/consume.js';
import { EMPTY_CLAIM, LEASE, claimAnswer, leaseAnswer } from '../helpers/leases.js';

const NOT_APPLIED = { writeOutcome: 'not_applied' as const };


test('the constants are the frozen consume-constants.json', () => {
  const frozen = JSON.parse(readFileSync('testdata/driver-vectors/consume-constants.json', 'utf8')) as Record<string, number | string>;
  assert.equal(handlerMarginMs(1_000), frozen['consume_margin_min_ms']);
  assert.equal(handlerMarginMs(30_000), 30_000 * (frozen['consume_margin_fraction'] as number));
  assert.equal(handlerMarginMs(3_600_000), 360_000);
  assert.equal(backoffMs(1, () => 1), frozen['consume_backoff_floor_ms']);
  assert.equal(backoffMs(40, () => 1), frozen['consume_backoff_ceiling_ms']);
  assert.equal(frozen['consume_backoff'], 'full_jitter_doubling');
});

test('the back-off is 100 ms doubling to 5 s, with full jitter', () => {
  assert.deepEqual([1, 2, 3, 4, 5, 6, 7, 8].map((attempt) => backoffMs(attempt, () => 1)), [100, 200, 400, 800, 1600, 3200, 5000, 5000]);
  assert.equal(backoffMs(3, () => 0), 0);
  assert.equal(backoffMs(3, () => 0.5), 200);
});

test('consume claims 10 entries for 30 s by default', async () => {
  const { queue, sent } = queueWith({ QUEUE_CLAIM: () => EMPTY_CLAIM });
  const controller = new AbortController();
  const done = settled(consumeLoop(queue, 'app/q', () => undefined, { signal: controller.signal }, fakeEnv()));
  await stopAfter(controller, done, () => sent.length >= 1);
  await done;
  assert.equal(sent[0]?.fields['limit'], 10);
  assert.equal(sent[0]?.fields['lease_ms'], 30_000);
});

test('consume passes its limit and lease through, and refuses ones outside their range before claiming', async () => {
  const { queue, sent } = queueWith({ QUEUE_CLAIM: () => EMPTY_CLAIM });
  for (const opts of [{ limit: 0 }, { limit: 101 }, { lease: 999 }, { lease: 3_600_001 }]) {
    const error = await settled(consumeLoop(queue, 'app/q', () => undefined, opts, fakeEnv()));
    assert.ok(error instanceof InvalidArgumentError, JSON.stringify(opts));
  }
  assert.equal(sent.length, 0);
  const controller = new AbortController();
  const done = settled(consumeLoop(queue, 'app/q', () => undefined, { limit: 3, lease: 5_000, signal: controller.signal }, fakeEnv()));
  await stopAfter(controller, done, () => sent.length >= 1);
  await done;
  assert.equal(sent[0]?.fields['limit'], 3);
  assert.equal(sent[0]?.fields['lease_ms'], 5_000);
});

test('an empty claim backs off; a claim that only returned expired leases claims again at once', async () => {
  const sleeps: number[] = [];
  const { queue, count } = queueWith({
    QUEUE_CLAIM: (_request, seen) => {
      if (seen === 1) return { found: false, returned: 2n, message: '' };
      return EMPTY_CLAIM;
    },
  });
  const controller = new AbortController();
  const done = settled(consumeLoop(queue, 'app/q', () => undefined, { signal: controller.signal }, fakeEnv(sleeps)));
  await stopAfter(controller, done, () => count('QUEUE_CLAIM') >= 4);
  await done;
  // Claim 1 returned expired leases: no sleep. Claims 2, 3 and 4 were empty: 100, 200, 400.
  assert.deepEqual(sleeps.slice(0, 3), [100, 200, 400]);
});

test('a claim that took entries resets the back-off', async () => {
  const sleeps: number[] = [];
  const { queue, count } = queueWith({
    QUEUE_CLAIM: (_request, seen) => (seen === 3 ? claimAnswer(1) : EMPTY_CLAIM),
    QUEUE_ACK: () => leaseAnswer({ lease_state: 'acked', acked: 1n }),
  });
  const controller = new AbortController();
  const done = settled(consumeLoop(queue, 'app/q', () => undefined, { signal: controller.signal }, fakeEnv(sleeps)));
  await stopAfter(controller, done, () => count('QUEUE_CLAIM') >= 5);
  await done;
  assert.deepEqual(sleeps.slice(0, 3), [100, 200, 100], 'two empty claims, then a batch, then back to the floor');
});

test('the handlers of a batch run at the same time, and only the ones that resolved are acknowledged', async () => {
  const { queue, sent, count } = queueWith({
    QUEUE_CLAIM: (_request, seen) => (seen === 1 ? claimAnswer(3) : EMPTY_CLAIM),
    QUEUE_ACK: () => leaseAnswer({ lease_state: 'acked', acked: 2n }),
  });
  let started = 0;
  let release!: () => void;
  const everyoneStarted = new Promise<void>((resolve) => {
    release = resolve;
  });
  const handler: ConsumeHandler = async (delivery) => {
    started += 1;
    if (started === 3) release();
    // Resolves only if all three handlers run concurrently; bounded, so a sequential loop fails in 300 ms.
    await within(everyoneStarted, 300, 'the other handlers to start');
    if (delivery.itemId === '0000000000000001') throw new Error('this one fails');
  };
  const controller = new AbortController();
  const done = settled(consumeLoop(queue, 'app/q', handler, { signal: controller.signal }, fakeEnv()));
  await stopAfter(controller, done, () => count('QUEUE_ACK') >= 1);
  await done;
  const ack = sent.find((request) => request.op === 'QUEUE_ACK');
  assert.equal(ack?.fields['lease_id'], LEASE);
  assert.deepEqual(ack?.fields['item_ids'], ['0000000000000000', '0000000000000002']);
});

test('a synchronous throw in a handler is a failed handler, not a crashed loop', async () => {
  const { queue, sent, count } = queueWith({
    QUEUE_CLAIM: (_request, seen) => (seen === 1 ? claimAnswer(2) : EMPTY_CLAIM),
    QUEUE_ACK: () => leaseAnswer({ lease_state: 'acked', acked: 1n }),
  });
  const controller = new AbortController();
  const handler: ConsumeHandler = (delivery) => {
    if (delivery.itemId === '0000000000000000') throw new Error('sync failure');
  };
  const done = settled(consumeLoop(queue, 'app/q', handler, { signal: controller.signal }, fakeEnv()));
  await stopAfter(controller, done, () => count('QUEUE_ACK') >= 1);
  assert.ok((await done) instanceof AbortedError);
  assert.deepEqual(sent.find((request) => request.op === 'QUEUE_ACK')?.fields['item_ids'], ['0000000000000001']);
});

test('a batch where every handler failed is not acknowledged at all', async () => {
  const { queue, count } = queueWith({
    QUEUE_CLAIM: (_request, seen) => (seen === 1 ? claimAnswer(2) : EMPTY_CLAIM),
    QUEUE_ACK: () => leaseAnswer({ lease_state: 'acked' }),
  });
  const controller = new AbortController();
  const done = settled(consumeLoop(queue, 'app/q', () => Promise.reject(new Error('no')), { signal: controller.signal }, fakeEnv()));
  await stopAfter(controller, done, () => count('QUEUE_CLAIM') >= 3);
  await done;
  assert.ok(count('QUEUE_CLAIM') >= 3, 'the loop went on claiming');
  assert.equal(count('QUEUE_ACK'), 0);
});

test('the handler deadline is the lease minus a margin: a handler that ignores nothing is told to stop at it', async () => {
  const { queue, sent, count } = queueWith({
    QUEUE_CLAIM: (_request, seen) => (seen === 1 ? claimAnswer(2, { leaseMs: 1_000 }) : EMPTY_CLAIM),
    QUEUE_ACK: () => leaseAnswer({ lease_state: 'acked', acked: 1n }),
  });
  const claimedAt = performance.now();
  let stoppedAfter = -1;
  const handler: ConsumeHandler = async (delivery, signal) => {
    if (delivery.itemId === '0000000000000000') return; // finishes at once
    await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
    stoppedAfter = performance.now() - claimedAt;
    throw signal.reason; // the slow one gives up when told
  };
  const controller = new AbortController();
  const done = settled(consumeLoop(queue, 'app/q', handler, { lease: 1_000, signal: controller.signal }, fakeEnv()));
  await stopAfter(controller, done, () => count('QUEUE_ACK') >= 1);
  await done;
  // 1000 ms lease, 250 ms margin: handlers are told to stop at 750 ms (the margin floor), well before 1000.
  assert.ok(stoppedAfter >= 700 && stoppedAfter < 950, `stopped at ${stoppedAfter} ms`);
  // The one that finished is acknowledged without waiting for the slow one's whole lease.
  assert.deepEqual(sent.find((request) => request.op === 'QUEUE_ACK')?.fields['item_ids'], ['0000000000000000']);
});

test('delivery.extend moves the whole lease and the batch deadline', async () => {
  const { queue, sent, count } = queueWith({
    QUEUE_CLAIM: (_request, seen) => (seen === 1 ? claimAnswer(1, { leaseMs: 1_000 }) : EMPTY_CLAIM),
    QUEUE_EXTEND: () => leaseAnswer({ lease_state: 'extended', lease_ms: 3_000n }),
    QUEUE_ACK: () => leaseAnswer({ lease_state: 'acked', acked: 1n }),
  });
  let grantedByExtend = -1;
  let abortedAtOldDeadline = true;
  const handler: ConsumeHandler = async (delivery, signal) => {
    grantedByExtend = await delivery.extend(3_000);
    await new Promise((resolve) => setTimeout(resolve, 900)); // past the original 750 ms deadline
    abortedAtOldDeadline = signal.aborted;
  };
  const controller = new AbortController();
  const done = settled(consumeLoop(queue, 'app/q', handler, { lease: 1_000, signal: controller.signal }, fakeEnv()));
  await stopAfter(controller, done, () => count('QUEUE_ACK') >= 1);
  await done;
  assert.equal(grantedByExtend, 3_000, 'extend resolves to the granted length');
  assert.equal(abortedAtOldDeadline, false, 'the extended deadline held');
  const extend = sent.find((request) => request.op === 'QUEUE_EXTEND');
  assert.equal(extend?.fields['lease_id'], LEASE);
  assert.equal(extend?.fields['lease_ms'], 3_000);
  assert.deepEqual(sent.find((request) => request.op === 'QUEUE_ACK')?.fields['item_ids'], ['0000000000000000']);
});

// ---- what a failed claim or ack does ---------------------------------------------------------

/** A recording queue whose claim (or ack) fails with `error` first, then is empty. */
function failingQueue(on: 'claim' | 'ack', error: () => HoardDBError): { queue: FifoBucket; count: (op: OpName) => number } {
  const fail = (): never => {
    throw error();
  };
  const { queue, count } = queueWith(
    on === 'claim'
      ? { QUEUE_CLAIM: (_request, seen) => (seen === 1 ? fail() : EMPTY_CLAIM) }
      : {
          QUEUE_CLAIM: (_request, seen) => (seen === 1 ? claimAnswer(1) : EMPTY_CLAIM),
          QUEUE_ACK: (_request, seen) => (seen === 1 ? fail() : leaseAnswer({ lease_state: 'acked' })),
        },
  );
  return { queue, count };
}

const CONTINUES: [string, () => HoardDBError][] = [
  ['UNAVAILABLE', () => new UnavailableError({ message: 'the owner is down', operation: 'claim', ...NOT_APPLIED })],
  ['UNAVAILABLE with an unknown outcome', () => new UnavailableError({ message: 'the owner changed under it', operation: 'claim', writeOutcome: 'unknown' })],
  ['TIMEOUT', () => new WriteConcernTimeoutError({ message: 'write concern timed out', operation: 'claim' })],
  ['a lost connection', () => new ConnectionError({ message: 'The connection failed during claim (reset).', operation: 'claim', writeOutcome: 'unknown' })],
];

for (const [label, error] of CONTINUES) {
  test(`consume backs off and claims again after ${label} on a claim`, async () => {
    const sleeps: number[] = [];
    const { queue, count } = failingQueue('claim', error);
    const controller = new AbortController();
    const done = settled(consumeLoop(queue, 'app/q', () => undefined, { signal: controller.signal }, fakeEnv(sleeps)));
    await stopAfter(controller, done, () => count('QUEUE_CLAIM') >= 2);
    assert.ok((await done) instanceof AbortedError, 'it ended only because it was stopped');
    assert.equal(sleeps[0], 100, 'it backed off first');
  });

  test(`consume goes on after ${label} on an ack`, async () => {
    const { queue, count } = failingQueue('ack', error);
    const controller = new AbortController();
    const done = settled(consumeLoop(queue, 'app/q', () => undefined, { signal: controller.signal }, fakeEnv()));
    await stopAfter(controller, done, () => count('QUEUE_CLAIM') >= 2);
    assert.ok((await done) instanceof AbortedError);
  });
}

for (const [state, make] of [
  ['expired', () => new LeaseExpiredError({ message: 'the lease expired', operation: 'ack' })],
  ['unknown', () => new LeaseUnknownError({ message: 'the lease is unknown', operation: 'ack' })],
] as const) {
  test(`consume goes on after an ack of a ${state} lease: the entries are in the queue again`, async () => {
    const { queue, count } = failingQueue('ack', make);
    const controller = new AbortController();
    const done = settled(consumeLoop(queue, 'app/q', () => undefined, { signal: controller.signal }, fakeEnv()));
    await stopAfter(controller, done, () => count('QUEUE_CLAIM') >= 2);
    assert.ok((await done) instanceof AbortedError);
  });
}

const ENDS: [string, () => HoardDBError, new (...args: never[]) => Error][] = [
  ['INVALID_ARGUMENT', () => new InvalidArgumentError({ message: 'bad claim', operation: 'claim', ...NOT_APPLIED }), InvalidArgumentError],
  ['a claim over the hard cap', () => new InvalidArgumentError({ message: 'claim refused: too big', operation: 'claim', ...NOT_APPLIED }), ClaimEntryTooLargeError],
  ['PERMISSION_DENIED', () => new PermissionDeniedError({ message: 'no grant', operation: 'claim', ...NOT_APPLIED }), PermissionDeniedError],
  ['NOT_FOUND', () => new NotFoundError({ message: 'no such bucket', operation: 'claim', ...NOT_APPLIED }), NotFoundError],
  ['INTERNAL', () => new InternalError({ message: 'disk', operation: 'claim' }), InternalError],
  ['an unknown code', () => new InternalError({ message: 'newer server', operation: 'claim' }, 'UNKNOWN(99)'), InternalError],
  ['NOT_AUTHENTICATED', () => new NotAuthenticatedError({ message: 'log in first', operation: 'claim' }), NotAuthenticatedError],
  ['POOL_TIMEOUT', () => new PoolTimeoutError({ message: 'no free connection', operation: 'claim' }), PoolTimeoutError],
  ['a request timeout', () => new RequestTimeoutError({ message: 'no answer in 30 s', operation: 'claim' }), RequestTimeoutError],
  ['a failed dial', () => new ConnectionError({ message: 'cannot connect', operation: 'claim', ...NOT_APPLIED }), ConnectionError],
];

for (const [label, error, expected] of ENDS) {
  test(`consume ends on ${label} on a claim, at the first one`, { timeout: 10_000 }, async () => {
    const { queue, count } = failingQueue('claim', error);
    // Bounded: a loop that wrongly retries this error fails in a second, it does not claim for ever.
    const controller = new AbortController();
    const failure = await within(settled(consumeLoop(queue, 'app/q', () => undefined, { signal: controller.signal }, fakeEnv())), 1_000, 'the loop to end').finally(() => controller.abort());
    assert.ok(failure instanceof expected, `rejected with ${String(failure)}`);
    assert.equal(count('QUEUE_CLAIM'), 1, 'one claim, then it ended');
  });
}

test('consume ends on an ack it cannot complete, after running the batch', async () => {
  const { queue, count } = failingQueue('ack', () => new InvalidArgumentError({ message: 'ack refused', operation: 'ack', ...NOT_APPLIED }));
  const failure = await settled(consumeLoop(queue, 'app/q', () => undefined, undefined, fakeEnv()));
  assert.ok(failure instanceof InvalidArgumentError);
  assert.equal(count('QUEUE_CLAIM'), 1);
});

test('isTransient is exactly UNAVAILABLE, TIMEOUT, OVERLOADED and a connection lost after sending', () => {
  const yes = [
    new UnavailableError({ message: 'x', operation: 'claim' }),
    new WriteConcernTimeoutError({ message: 'x', operation: 'claim' }),
    new OverloadedError({ message: 'x', operation: 'claim' }),
    new ConnectionError({ message: 'x', operation: 'claim', writeOutcome: 'unknown' }),
  ];
  const no = [
    new InvalidArgumentError({ message: 'x', operation: 'claim' }),
    new PermissionDeniedError({ message: 'x', operation: 'claim' }),
    new NotFoundError({ message: 'x', operation: 'claim' }),
    new InternalError({ message: 'x', operation: 'claim' }),
    new NotAuthenticatedError({ message: 'x', operation: 'claim' }),
    new PoolTimeoutError({ message: 'x', operation: 'claim' }),
    new RequestTimeoutError({ message: 'x', operation: 'claim' }),
    new ConnectionError({ message: 'x', operation: 'claim', writeOutcome: 'not_applied' }),
    new Error('not ours'),
    undefined,
  ];
  for (const error of yes) assert.equal(isTransient(error), true, String(error));
  for (const error of no) assert.equal(isTransient(error), false, String(error));
});

// ---- stopping --------------------------------------------------------------------------------

test('consume stops before claiming when the signal is already aborted', async () => {
  const { queue, sent } = queueWith({ QUEUE_CLAIM: () => EMPTY_CLAIM });
  const controller = new AbortController();
  controller.abort();
  const failure = await settled(consumeLoop(queue, 'app/q', () => undefined, { signal: controller.signal }, fakeEnv()));
  assert.ok(failure instanceof AbortedError);
  assert.equal(sent.length, 0);
});

test('consume stops promptly while it is backing off', async () => {
  const { queue, count } = queueWith({ QUEUE_CLAIM: () => EMPTY_CLAIM });
  const controller = new AbortController();
  const env: ConsumeEnv = { ...fakeEnv(), sleep: (_ms, signal) => new Promise((_resolve, reject) => signal?.addEventListener('abort', () => reject(signal.reason), { once: true })) };
  const done = settled(consumeLoop(queue, 'app/q', () => undefined, { signal: controller.signal }, env));
  await stopAfter(controller, done, () => count('QUEUE_CLAIM') >= 1);
  assert.ok((await done) instanceof AbortedError);
});

test('on stop, consume waits for every handler, then releases what it has not acknowledged', async () => {
  const { queue, sent, count } = queueWith({
    QUEUE_CLAIM: (_request, seen) => (seen === 1 ? claimAnswer(2) : EMPTY_CLAIM),
    QUEUE_ACK: () => leaseAnswer({ lease_state: 'acked', acked: 1n }),
    QUEUE_RELEASE: () => leaseAnswer({ lease_state: 'released', released: 1n }),
  });
  const controller = new AbortController();
  let slowFinishedAt = 0;
  const handler: ConsumeHandler = async (delivery, signal) => {
    if (delivery.itemId === '0000000000000000') return;
    await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
    await new Promise((resolve) => setTimeout(resolve, 80)); // takes its time to wind down
    slowFinishedAt = performance.now();
    throw new Error('stopped');
  };
  const done = settled(consumeLoop(queue, 'app/q', handler, { signal: controller.signal }, fakeEnv()));
  await new Promise((resolve) => setTimeout(resolve, 30)); // both handlers are running
  controller.abort();
  const failure = await done;
  const settledAt = performance.now();
  assert.ok(failure instanceof AbortedError, `rejected with ${String(failure)}`);
  assert.ok(settledAt >= slowFinishedAt && slowFinishedAt > 0, 'consume did not settle while a handler was running');
  const ops = sent.map((request) => request.op);
  assert.deepEqual(ops.filter((op) => op === 'QUEUE_RELEASE'), ['QUEUE_RELEASE'], 'one release');
  assert.equal(sent.find((request) => request.op === 'QUEUE_RELEASE')?.fields['lease_id'], LEASE);
  assert.ok(ops.lastIndexOf('QUEUE_RELEASE') > ops.indexOf('QUEUE_CLAIM'));
  assert.equal(count('QUEUE_RELEASE'), 1);
});

test('a release that finds the lease already settled is the expected answer, not a failure', async () => {
  const { queue } = queueWith({
    QUEUE_CLAIM: (_request, seen) => (seen === 1 ? claimAnswer(1) : EMPTY_CLAIM),
    QUEUE_ACK: () => leaseAnswer({ lease_state: 'acked', acked: 1n }),
    QUEUE_RELEASE: () => ({ success: false, lease_state: 'unknown', message: 'the lease is settled' }),
  });
  const controller = new AbortController();
  const handler: ConsumeHandler = async () => {
    controller.abort();
  };
  const warnings: string[] = [];
  const env = { ...fakeEnv(), logger: { debug: () => undefined, warn: (message: string) => void warnings.push(message) } };
  const failure = await settled(consumeLoop(queue, 'app/q', handler, { signal: controller.signal }, env));
  assert.ok(failure instanceof AbortedError);
  assert.deepEqual(warnings, [], 'nothing to warn about');
});

test('an abort during a claim rejects with AbortedError, not the claim failure', async () => {
  const controller = new AbortController();
  const answers = new Map<OpName, AnswerFrom>([
    [
      'QUEUE_CLAIM',
      () => {
        controller.abort();
        throw new UnavailableError({ message: 'gone', operation: 'claim' });
      },
    ],
  ]);
  const { client } = recordingClient(answers);
  const failure = await settled(consumeLoop(client.database('app').fifo('q'), 'app/q', () => undefined, { signal: controller.signal }, fakeEnv()));
  assert.ok(failure instanceof AbortedError, `rejected with ${String(failure)}`);
});

test('the default env sleeps for real and stops when aborted', async () => {
  const controller = new AbortController();
  const started = performance.now();
  const sleeping = defaultConsumeEnv.sleep(10_000, controller.signal);
  setTimeout(() => controller.abort(), 20);
  await assert.rejects(sleeping);
  assert.ok(performance.now() - started < 1_000);
  await defaultConsumeEnv.sleep(5);
});

test('a handler is not given a signal that is already aborted', async () => {
  const { queue, count } = queueWith({
    QUEUE_CLAIM: (_request, seen) => (seen === 1 ? claimAnswer(1) : EMPTY_CLAIM),
    QUEUE_ACK: () => leaseAnswer({ lease_state: 'acked', acked: 1n }),
  });
  let sawAborted: boolean | undefined;
  const controller = new AbortController();
  const handler = (_delivery: Delivery, signal: AbortSignal): void => {
    sawAborted = signal.aborted;
  };
  const done = settled(consumeLoop(queue, 'app/q', handler, { signal: controller.signal }, fakeEnv()));
  await stopAfter(controller, done, () => count('QUEUE_ACK') >= 1);
  await done;
  assert.equal(sawAborted, false);
});

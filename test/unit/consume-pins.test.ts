// SPDX-License-Identifier: Apache-2.0
//
// consume's behaviour that a mutation run found nothing pinned: what the batch deadline does with a
// granted length, what a stopped loop sends and under what deadline, and what a claim, an ack and a
// handler deadline do while the world is slow. Every wait is bounded, so a wrong branch fails in about
// a second with a message naming what it was waiting for.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Batch, batchDeliveries, consumeLoop, type ConsumeEnv } from '../../src/consume.js';
import { AbortedError, UnavailableError } from '../../src/errors.js';
import type { AckOptions, ClaimOptions, ConsumeHandler, Delivery, Doc, FifoBucket, LeaseVerbs, WriteOptions } from '../../src/types.js';
import { LEASE, claimAnswer, leaseAnswer } from '../helpers/leases.js';
import { fakeEnv, queueWith, settled, waitFor, within } from '../helpers/consume.js';

const TEST = { timeout: 10_000 };

/** A delivery whose extend answers `grant` whatever it is asked, as a server that caps the lease does. */
function grantingDelivery(grant: number, onExtend: () => void = () => undefined): Delivery {
  return {
    itemId: '0000000000000000',
    document: { _id_: 'id-0' },
    deliveries: 1,
    extend: async () => {
      onExtend();
      return grant;
    },
  };
}

// ---- Batch and batchDeliveries ---------------------------------------------------------------

test('a delivery moves its batch by the length the server granted, not the length it asked for', TEST, async () => {
  const moves: [number, number][] = [];
  const [delivery] = batchDeliveries([grantingDelivery(4_000)], { move: (sentAt, granted) => void moves.push([sentAt, granted]) }, () => 7);
  assert.equal(await delivery?.extend(60_000), 4_000, 'the caller is told the granted length');
  assert.deepEqual(moves, [[7, 4_000]], 'the batch is moved by 4000, not 60000');
});

test('the batch is moved from the time the extend was sent, not the time its answer came', TEST, async () => {
  const clock = { t: 100 };
  const moves: number[] = [];
  const [delivery] = batchDeliveries([grantingDelivery(4_000, () => (clock.t = 900))], { move: (sentAt) => void moves.push(sentAt) }, () => clock.t);
  await delivery?.extend(4_000);
  assert.deepEqual(moves, [100]);
});

function batchAt(clock: { t: number }, sentAt: number, grantedMs: number): { batch: Batch; expired: () => number } {
  let expiries = 0;
  const env: ConsumeEnv = { ...fakeEnv(), now: () => clock.t };
  // A margin of 1000 ms: a deadline at sentAt + granted - 1000. The timer is cleared by stop().
  return { batch: new Batch(env, 1_000, sentAt, grantedMs, () => void (expiries += 1)), expired: () => expiries };
}

test('Batch.move only ever moves the deadline later', TEST, () => {
  const clock = { t: 0 };
  const { batch } = batchAt(clock, 0, 10_000);
  try {
    assert.equal(batch.deadline, 9_000);
    batch.move(0, 4_000); // a shorter grant
    assert.equal(batch.deadline, 9_000, 'a shorter lease does not pull the deadline in');
    batch.move(0, 10_000); // the same
    assert.equal(batch.deadline, 9_000);
    batch.move(0, 12_000);
    assert.equal(batch.deadline, 11_000, 'a longer one pushes it out');
  } finally {
    batch.stop();
  }
});

test('Batch.move counts the lease from when the request was sent, not from now', TEST, () => {
  const clock = { t: 0 };
  const { batch } = batchAt(clock, 0, 10_000);
  try {
    clock.t = 5_000; // the answer came 5 s after the request left
    batch.move(2_000, 20_000);
    assert.equal(batch.deadline, 21_000, '2000 + 20000 - 1000, not 5000 + 20000 - 1000');
  } finally {
    batch.stop();
  }
});

test('Batch expires at its deadline, once', TEST, async () => {
  const clock = { t: 0 };
  const { batch, expired } = batchAt(clock, 0, 1_050); // deadline 50 ms
  try {
    await waitFor(() => expired() === 1, 'the batch to expire');
  } finally {
    batch.stop();
  }
});

// ---- the claim loop --------------------------------------------------------------------------

test('a claim that returned expired leases and took nothing is followed by a claim with no sleep before it', TEST, async () => {
  const sleeps: number[] = [];
  const sleepsSeenAtClaim: number[] = [];
  const { queue, count } = queueWith({
    QUEUE_CLAIM: (_request, seen) => {
      sleepsSeenAtClaim.push(sleeps.length);
      return seen === 1 ? { found: false, returned: 2n, message: '' } : { found: false, message: 'queue is empty' };
    },
  });
  const controller = new AbortController();
  const done = settled(consumeLoop(queue, 'app/q', () => undefined, { signal: controller.signal }, fakeEnv(sleeps)));
  try {
    await waitFor(() => count('QUEUE_CLAIM') >= 3, 'three claims');
  } finally {
    controller.abort();
  }
  assert.ok((await within(done, 2_000, 'the loop to stop')) instanceof AbortedError);
  assert.deepEqual(sleepsSeenAtClaim.slice(0, 3), [0, 0, 1], 'claim 2 came before any sleep; claim 3 after the first back-off');
});

// ---- handler deadline ------------------------------------------------------------------------

test('at the handler deadline the finished entries are acknowledged while a handler that ignores its signal still runs', TEST, async () => {
  const { queue, sent, count } = queueWith({
    // A lease of 300 ms: handlers are told to stop at 50 ms.
    QUEUE_CLAIM: (_request, seen) => (seen === 1 ? claimAnswer(2, { leaseMs: 300 }) : { found: false, message: 'queue is empty' }),
    QUEUE_ACK: () => leaseAnswer({ lease_state: 'acked', acked: 1n }),
  });
  let openGate!: () => void;
  const gate = new Promise<void>((resolve) => {
    openGate = resolve;
  });
  let stuckStillRunning = false;
  const handler: ConsumeHandler = async (delivery) => {
    if (delivery.itemId === '0000000000000000') return;
    stuckStillRunning = true;
    await gate; // never looks at its signal
    stuckStillRunning = false;
  };
  const controller = new AbortController();
  const done = settled(consumeLoop(queue, 'app/q', handler, { signal: controller.signal }, fakeEnv()));
  try {
    await waitFor(() => count('QUEUE_ACK') >= 1, 'the ack of the finished entry at the deadline');
    assert.equal(stuckStillRunning, true, 'the other handler is still running');
    assert.deepEqual(sent.find((request) => request.op === 'QUEUE_ACK')?.fields['item_ids'], ['0000000000000000']);
  } finally {
    openGate();
    controller.abort();
  }
  await within(done, 2_000, 'the loop to stop');
});

// ---- stopping: what is sent, and under what deadline ----------------------------------------------

interface SeenOptions {
  claim: (ClaimOptions | undefined)[];
  ack: (AckOptions | undefined)[];
  release: (WriteOptions | undefined)[];
}

/** The queue's lease verbs, with the options each call was given kept; `around` may replace a verb. */
function spying(queue: FifoBucket, around: Partial<LeaseVerbs<Doc>> = {}): { bucket: LeaseVerbs<Doc>; seen: SeenOptions } {
  const seen: SeenOptions = { claim: [], ack: [], release: [] };
  const bucket: LeaseVerbs<Doc> = {
    claim: (opts) => {
      seen.claim.push(opts);
      return around.claim?.(opts) ?? queue.claim(opts);
    },
    ack: (leaseId, opts) => {
      seen.ack.push(opts);
      return around.ack?.(leaseId, opts) ?? queue.ack(leaseId, opts);
    },
    release: (leaseId, opts) => {
      seen.release.push(opts);
      return around.release?.(leaseId, opts) ?? queue.release(leaseId, opts);
    },
    extend: (leaseId, ms, opts) => queue.extend(leaseId, ms, opts),
  } as LeaseVerbs<Doc>;
  return { bucket, seen };
}

function stopQueue(): ReturnType<typeof queueWith> {
  return queueWith({
    QUEUE_CLAIM: (_request, seen) => (seen === 1 ? claimAnswer(2) : { found: false, message: 'queue is empty' }),
    QUEUE_ACK: () => leaseAnswer({ lease_state: 'acked', acked: 1n }),
    QUEUE_RELEASE: () => leaseAnswer({ lease_state: 'released', released: 1n }),
  });
}

test('a handler that finished before the stop is acknowledged under the 5 s release deadline, then the rest is released the same way', TEST, async () => {
  const { queue, sent } = stopQueue();
  const { bucket, seen } = spying(queue);
  const controller = new AbortController();
  let slowRunning = false;
  const handler: ConsumeHandler = async (delivery, signal) => {
    if (delivery.itemId === '0000000000000000') return;
    slowRunning = true;
    await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
    throw new Error('stopped');
  };
  const done = settled(consumeLoop(bucket, 'app/q', handler, { signal: controller.signal }, fakeEnv()));
  await waitFor(() => slowRunning, 'the slow handler to start');
  controller.abort();
  const failure = await within(done, 2_000, 'the loop to settle after the stop');
  assert.ok(failure instanceof AbortedError, String(failure));

  const ack = sent.find((request) => request.op === 'QUEUE_ACK');
  assert.deepEqual(ack?.fields['item_ids'], ['0000000000000000'], 'the finished entry was acknowledged, though the loop was stopping');
  assert.equal(seen.ack.length, 1);
  assert.equal(seen.ack[0]?.timeoutMs, 5_000, 'the ack of a stopped loop carries its own deadline');
  assert.equal(seen.ack[0]?.signal, undefined, 'and not the aborted signal');
  assert.equal(seen.release.length, 1);
  assert.equal(seen.release[0]?.timeoutMs, 5_000, 'the release carries the 5 s deadline');
  assert.equal(sent.find((request) => request.op === 'QUEUE_RELEASE')?.fields['lease_id'], LEASE);
});

test('while running, the caller signal goes to the claim and to the ack, and no timeout is added', TEST, async () => {
  const { queue, count } = queueWith({
    QUEUE_CLAIM: (_request, seen) => (seen === 1 ? claimAnswer(1) : { found: false, message: 'queue is empty' }),
    QUEUE_ACK: () => leaseAnswer({ lease_state: 'acked', acked: 1n }),
  });
  const { bucket, seen } = spying(queue);
  const controller = new AbortController();
  const done = settled(consumeLoop(bucket, 'app/q', () => undefined, { signal: controller.signal }, fakeEnv()));
  try {
    await waitFor(() => count('QUEUE_ACK') >= 1, 'the ack');
  } finally {
    controller.abort();
  }
  await within(done, 2_000, 'the loop to stop');
  assert.equal(seen.claim[0]?.signal, controller.signal);
  assert.equal(seen.ack[0]?.signal, controller.signal);
  assert.equal(seen.ack[0]?.timeoutMs, undefined);
});

test('an abort while a claim is in flight ends the loop promptly', TEST, async () => {
  const { queue } = queueWith({ QUEUE_CLAIM: () => ({ found: false }) });
  // A claim that answers only when its signal aborts: with no signal it never answers.
  const { bucket } = spying(queue, {
    claim: (opts) =>
      new Promise((_resolve, reject) => {
        opts?.signal?.addEventListener('abort', () => reject(new UnavailableError({ message: 'cut off', operation: 'claim' })), { once: true });
      }),
  });
  const controller = new AbortController();
  const done = settled(consumeLoop(bucket, 'app/q', () => undefined, { signal: controller.signal }, fakeEnv()));
  setTimeout(() => controller.abort(), 20);
  const failure = await within(done, 1_000, 'the loop to end after the abort');
  assert.ok(failure instanceof AbortedError, String(failure));
});

test('an abort while an ack is in flight ends the loop promptly, and releases', TEST, async () => {
  const { queue, count } = queueWith({
    QUEUE_CLAIM: (_request, seen) => (seen === 1 ? claimAnswer(1) : { found: false, message: 'queue is empty' }),
    QUEUE_RELEASE: () => leaseAnswer({ lease_state: 'released', released: 1n }),
  });
  let ackStarted = false;
  const { bucket } = spying(queue, {
    ack: (_leaseId, opts) =>
      new Promise((_resolve, reject) => {
        ackStarted = true;
        opts?.signal?.addEventListener('abort', () => reject(new UnavailableError({ message: 'cut off', operation: 'ack' })), { once: true });
      }),
  });
  const controller = new AbortController();
  const done = settled(consumeLoop(bucket, 'app/q', () => undefined, { signal: controller.signal }, fakeEnv()));
  await waitFor(() => ackStarted, 'the ack to start');
  controller.abort();
  const failure = await within(done, 1_000, 'the loop to end after the abort');
  assert.ok(failure instanceof AbortedError, String(failure));
  assert.equal(count('QUEUE_RELEASE'), 1);
});

// ---- handlers run together ------------------------------------------------------------------

test('the handlers of a batch run at the same time: each starts before any has finished', TEST, async () => {
  const { queue, count } = queueWith({
    QUEUE_CLAIM: (_request, seen) => (seen === 1 ? claimAnswer(3) : { found: false, message: 'queue is empty' }),
    QUEUE_ACK: () => leaseAnswer({ lease_state: 'acked', acked: 3n }),
  });
  let started = 0;
  let allStarted!: () => void;
  const everyoneStarted = new Promise<void>((resolve) => {
    allStarted = resolve;
  });
  const handler: ConsumeHandler = async () => {
    started += 1;
    if (started === 3) allStarted();
    // Bounded: a loop that ran the handlers one after the other fails here, in 300 ms, not at the runner's timeout.
    await within(everyoneStarted, 300, 'the other handlers to start');
  };
  const controller = new AbortController();
  const done = settled(consumeLoop(queue, 'app/q', handler, { signal: controller.signal }, fakeEnv()));
  try {
    await waitFor(() => count('QUEUE_ACK') >= 1, 'the ack of three entries');
  } finally {
    controller.abort();
  }
  await within(done, 2_000, 'the loop to stop');
  assert.equal(started, 3);
});

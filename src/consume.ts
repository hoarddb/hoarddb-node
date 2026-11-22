// SPDX-License-Identifier: Apache-2.0
//
// The claim, handle, ack loop (handbook api-go.md section 5.2, owner's decision 2026-10-20). Delivery
// is at-least-once, so claiming again is always safe: the loop backs off and goes on after anything
// waiting may cure, and ends, rejecting with the error, after anything a person must fix. It never
// resends a claim or an ack whose answer was lost; it issues a new claim.

import { AbortedError, isHoardDBError, LeaseExpiredError, LeaseUnknownError } from './errors.js';
import { claimLimitOf, leaseMsOf } from './leases.js';
import type { ConsumeHandler, ConsumeOptions, Delivery, LeaseVerbs, Logger } from './types.js';

const LIMIT_DEFAULT = 10;
const LEASE_MS_DEFAULT = 30_000;
/** A handler's deadline is the lease minus a margin: a tenth of the lease, at least 250 ms. */
const MARGIN_MIN_MS = 250;
const MARGIN_DIVISOR = 10;
const BACKOFF_FLOOR_MS = 100;
const BACKOFF_CEILING_MS = 5_000;
/** The release of a stopped batch has no caller signal left to run under, so it gets its own deadline. */
const RELEASE_TIMEOUT_MS = 5_000;

/** What the loop needs from the world besides the bucket: randomness, a sleep, a clock and a logger. */
export interface ConsumeEnv {
  random(): number;
  /** Resolves after `ms`; rejects when `signal` aborts first. */
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
  /** A monotonic clock in milliseconds. */
  now(): number;
  logger?: Logger;
}

export const defaultConsumeEnv: ConsumeEnv = {
  random: Math.random,
  sleep: (ms, signal) =>
    new Promise<void>((resolve, reject) => {
      if (signal?.aborted === true) {
        reject(signal.reason);
        return;
      }
      const onAbort = (): void => {
        clearTimeout(timer);
        reject(signal?.reason);
      };
      const timer = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      }, ms);
      signal?.addEventListener('abort', onAbort, { once: true });
    }),
  now: () => performance.now(),
};

/** How long before the lease ends handlers are told to stop: a tenth of the lease, at least 250 ms. */
export function handlerMarginMs(grantedMs: number): number {
  return Math.max(MARGIN_MIN_MS, grantedMs / MARGIN_DIVISOR);
}

/** The wait after the `attempt`th empty or failed claim in a row: 100 ms doubling to 5 s, full jitter. */
export function backoffMs(attempt: number, random: () => number): number {
  return random() * Math.min(BACKOFF_CEILING_MS, BACKOFF_FLOOR_MS * 2 ** (attempt - 1));
}

/**
 * Whether waiting may cure the error: the server could not answer here and now (UNAVAILABLE), took too
 * long (TIMEOUT), was overloaded, or the connection was lost after the request went out. Everything
 * else is one a person must fix; a failed dial and a request timeout are among them, as in the Go driver.
 */
export function isTransient(error: unknown): boolean {
  if (!isHoardDBError(error)) return false;
  if (error.code === 'UNAVAILABLE' || error.code === 'TIMEOUT' || error.code === 'OVERLOADED') return true;
  return error.code === 'CONNECTION_FAILED' && error.writeOutcome === 'unknown';
}

function stopped(target: string, signal: AbortSignal | undefined): AbortedError {
  return new AbortedError({
    message: `consume on ${target} was stopped. What it had not acknowledged was released, and every handler had returned.`,
    operation: 'consume',
    target,
    cause: signal?.reason,
  });
}

/** The shared handler deadline of one claimed batch (exported for its unit tests). */
export class Batch {
  deadline: number;
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly env: ConsumeEnv,
    private readonly margin: number,
    sentAt: number,
    grantedMs: number,
    private readonly expire: () => void,
  ) {
    this.deadline = sentAt + grantedMs - margin;
    this.arm();
  }

  private arm(): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(this.expire, Math.max(0, this.deadline - this.env.now()));
  }

  /** Pushes the deadline out to a lease of `grantedMs` that began when the extending request was sent. */
  move(sentAt: number, grantedMs: number): void {
    const later = sentAt + grantedMs - this.margin;
    if (later > this.deadline) {
      this.deadline = later;
      this.arm();
    }
  }

  stop(): void {
    clearTimeout(this.timer);
  }
}

export async function consumeLoop<T extends object>(
  bucket: LeaseVerbs<T>,
  target: string,
  handler: ConsumeHandler<T>,
  opts: ConsumeOptions | undefined,
  env: ConsumeEnv,
): Promise<void> {
  const limit = claimLimitOf(opts?.limit ?? LIMIT_DEFAULT, 'consume', target);
  const lease = leaseMsOf(opts?.lease ?? LEASE_MS_DEFAULT, 'consume', target);
  const signal = opts?.signal;
  let waits = 0;
  // A function, so a check after an await is not narrowed by an earlier one.
  const isStopped = (): boolean => signal?.aborted === true;

  for (;;) {
    if (isStopped()) throw stopped(target, signal);
    const sentAt = env.now();
    let claimed;
    try {
      claimed = await bucket.claim({ limit, lease, signal });
    } catch (error) {
      if (isStopped()) throw stopped(target, signal);
      if (!isTransient(error)) throw error;
      claimed = undefined;
    }
    if (claimed === undefined || (claimed.items.length === 0 && claimed.returned === 0)) {
      // Nothing to take, or a failure waiting may cure: re-claiming is safe, delivery is at-least-once.
      waits += 1;
      await sleepUnlessStopped(env, backoffMs(waits, env.random), signal, target);
      continue;
    }
    waits = 0;
    // Expired leases went back and took nothing: claim again at once.
    if (claimed.items.length === 0) continue;
    await runBatch(bucket, target, claimed.leaseId, claimed.grantedMs, claimed.items, sentAt, handler, signal, env);
  }
}

async function sleepUnlessStopped(env: ConsumeEnv, ms: number, signal: AbortSignal | undefined, target: string): Promise<void> {
  try {
    await env.sleep(ms, signal);
  } catch (error) {
    if (signal?.aborted === true) throw stopped(target, signal);
    throw error;
  }
}

/** The deliveries a batch hands out: each one's extend also moves the batch's handler deadline. */
export function batchDeliveries<T extends object>(items: Delivery<T>[], batch: { move(sentAt: number, grantedMs: number): void }, now: () => number): Delivery<T>[] {
  return items.map((item) => ({
    ...item,
    extend: async (ms, opts) => {
      const sentAt = now();
      const granted = await item.extend(ms, opts);
      batch.move(sentAt, granted);
      return granted;
    },
  }));
}

async function runBatch<T extends object>(
  bucket: LeaseVerbs<T>,
  target: string,
  leaseId: string,
  grantedMs: number,
  items: Delivery<T>[],
  sentAt: number,
  handler: ConsumeHandler<T>,
  signal: AbortSignal | undefined,
  env: ConsumeEnv,
): Promise<void> {
  const handlers = new AbortController();
  const onStop = (): void => handlers.abort(signal?.reason);
  signal?.addEventListener('abort', onStop, { once: true });
  const batch = new Batch(env, handlerMarginMs(grantedMs), sentAt, grantedMs, () => handlers.abort(new Error('the handler deadline passed')));
  const acknowledged: string[] = [];

  try {
    const runs = batchDeliveries(items, batch, env.now).map(async (delivery) => {
      try {
        await handler(delivery, handlers.signal);
        acknowledged.push(delivery.itemId);
      } catch (error) {
        env.logger?.warn('a consume handler failed; its entry is not acknowledged and will be delivered again', {
          bucket: target,
          error: String(error),
        });
      }
    });
    const allReturned = Promise.allSettled(runs);
    const expired = new Promise<void>((resolve) => {
      if (handlers.signal.aborted) resolve();
      else handlers.signal.addEventListener('abort', () => resolve(), { once: true });
    });
    await Promise.race([allReturned, expired]);

    // A stopped caller's signal cannot carry the ack: it runs under its own short deadline.
    const settle = signal?.aborted === true ? { timeoutMs: RELEASE_TIMEOUT_MS } : { signal };
    let ackFailure: unknown;
    const toAck = [...acknowledged];
    if (toAck.length > 0) {
      try {
        await bucket.ack(leaseId, { itemIds: toAck, ...settle });
      } catch (error) {
        ackFailure = error;
      }
    }
    // Never settle with a handler still running; one that finishes while the loop is stopping is
    // covered by the single release below.
    await allReturned;
    if (signal?.aborted === true) {
      await releaseOnStop(bucket, target, leaseId, env);
      throw stopped(target, signal);
    }
    // An ack that came too late, or whose answer was lost, costs a redelivery and nothing else.
    if (ackFailure !== undefined && !(ackFailure instanceof LeaseExpiredError) && !(ackFailure instanceof LeaseUnknownError) && !isTransient(ackFailure)) {
      throw ackFailure;
    }
  } finally {
    batch.stop();
    signal?.removeEventListener('abort', onStop);
  }
}

/** Gives the lease's unacknowledged entries back now, not when it runs out. */
async function releaseOnStop<T extends object>(bucket: LeaseVerbs<T>, target: string, leaseId: string, env: ConsumeEnv): Promise<void> {
  try {
    await bucket.release(leaseId, { timeoutMs: RELEASE_TIMEOUT_MS });
  } catch (error) {
    // A lease already settled is the expected answer after an ack of everything.
    if (error instanceof LeaseUnknownError || error instanceof LeaseExpiredError) return;
    env.logger?.warn('consume could not release its lease on stop; the entries return when it expires', { bucket: target, error: String(error) });
  }
}

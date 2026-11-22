// SPDX-License-Identifier: Apache-2.0
//
// What the consume tests share: an env whose sleeps are recorded and instant, a recording queue whose
// answers are computed per call, and helpers that make a wrong branch fail in about a second instead
// of hanging until the runner's timeout.

import type { ConsumeEnv } from '../../src/consume.js';
import type { FifoBucket } from '../../src/types.js';
import type { OpName } from '../../src/wire/opcodes.js';
import { recordingClient, type AnswerFrom, type RecordedRequest } from './recording.js';

/** An env whose sleeps are recorded and instant, and whose random is 1 (the top of the jitter). */
export function fakeEnv(sleeps: number[] = []): ConsumeEnv {
  return {
    random: () => 1,
    sleep: (ms, signal) => {
      sleeps.push(ms);
      // Yield, so a loop that only ever sleeps lets the test's own timers and aborts run.
      return new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, 1);
        signal?.addEventListener('abort', () => {
          clearTimeout(timer);
          reject(signal.reason);
        }, { once: true });
      });
    },
    now: () => performance.now(),
  };
}

export type Responder = (request: { op: OpName; fields: Record<string, unknown> }, count: number) => Record<string, unknown>;

/** A recording queue whose answers are computed per call; `counts` is how many of each op came so far. */
export function queueWith(responders: Partial<Record<OpName, Responder>>): { queue: FifoBucket; sent: RecordedRequest[]; count: (op: OpName) => number } {
  const counts = new Map<OpName, number>();
  const answers = new Map<OpName, AnswerFrom>();
  for (const [op, responder] of Object.entries(responders) as [OpName, Responder][]) {
    answers.set(op, (request) => {
      const seen = (counts.get(op) ?? 0) + 1;
      counts.set(op, seen);
      return responder(request, seen);
    });
  }
  const { client, sent } = recordingClient(answers);
  return { queue: client.database('app').fifo('q'), sent, count: (op) => counts.get(op) ?? 0 };
}


/** Aborts the loop once `condition` holds; gives up waiting when the loop has already ended or 3 s pass. */
export function stopAfter(controller: AbortController, done: Promise<unknown>, condition: () => boolean): Promise<void> {
  return new Promise((resolve) => {
    let ended = false;
    void done.then(() => {
      ended = true;
    });
    const started = Date.now();
    const tick = setInterval(() => {
      if (condition() || ended || Date.now() - started > 3_000) {
        clearInterval(tick);
        controller.abort();
        resolve();
      }
    }, 2);
    tick.unref();
  });
}

export async function settled(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
    return undefined;
  } catch (error) {
    return error;
  }
}

/** Rejects, naming `what`, when `promise` has not settled within `ms`: a wrong branch fails fast. */
export function within<V>(promise: Promise<V>, ms: number, what: string): Promise<V> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms} ms waiting for ${what}`)), ms);
  });
  return Promise.race([promise, late]).finally(() => clearTimeout(timer));
}

/** Resolves once `condition` holds; rejects, naming `what`, after `ms`. */
export function waitFor(condition: () => boolean, what: string, ms = 2_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = setInterval(() => {
      if (condition()) {
        clearInterval(tick);
        resolve();
      } else if (Date.now() - started > ms) {
        clearInterval(tick);
        reject(new Error(`timed out after ${ms} ms waiting for ${what}`));
      }
    }, 2);
  });
}


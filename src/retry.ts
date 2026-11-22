// SPDX-License-Identifier: Apache-2.0
//
// The retry table (build doc section 5.4; handbook errors.md section 6) and nothing else. The rules
// live in one place because each of them fails silently when it is broken in a caller: a read that
// is not retried looks like an outage, and a write that is retried is a document pushed twice. What
// decides the table is the kind of the call and whether an answer byte had arrived, never the
// number of attempts alone.

import type { CallKind, HoardDBError } from './errors.js';

export type { CallKind };

/** What the caller should do next: go again at once, wait and go again, or hear about it. */
export type RetryDecision =
  | { action: 'retry-now' }
  | { action: 'retry-after'; delayMs: number }
  | { action: 'fail' };

/** Full jitter on the wait between attempts, doubling per attempt and never past 5 s. */
const BACKOFF_CEILING_MS = 5_000;
const BACKOFF_BASE_MS = 100;

/**
 * The wait before attempt n+1 (n attempts made). A wait that would land past the call's own
 * deadline is not a retry: the caller would hear a timeout instead of whatever the retry was for.
 */
function backoff(input: {
  attempts: number;
  remainingMs: number;
  random: () => number;
}): RetryDecision {
  const delayMs =
    input.random() * Math.min(BACKOFF_CEILING_MS, BACKOFF_BASE_MS * 2 ** (input.attempts - 1));
  if (delayMs >= input.remainingMs) return { action: 'fail' };
  return { action: 'retry-after', delayMs };
}

export function decideRetry(input: {
  error: HoardDBError;
  kind: CallKind;
  attempts: number;
  responseStarted: boolean;
  /** An answer that carries a request ID answers that request; a zero-ID refusal belongs to the connection. */
  answersRequest?: boolean;
  remainingMs: number;
  random: () => number;
}): RetryDecision {
  const { error, kind, attempts, responseStarted } = input;

  // An unknown outcome is a lost answer rather than a refusal: repeating it could push twice.
  if (error.writeOutcome === 'unknown') return { action: 'fail' };

  switch (error.code) {
    // Nothing reached the server, so a read can go again on a fresh connection exactly once; past
    // the first attempt the host is down rather than unlucky.
    case 'CONNECTION_FAILED':
      if (responseStarted || kind !== 'read' || attempts > 1) return { action: 'fail' };
      return { action: 'retry-now' };

    // The server says this socket is not authenticated any more. One read on a new one, no writes.
    case 'NOT_AUTHENTICATED':
      if (kind !== 'read' || attempts > 1) return { action: 'fail' };
      return { action: 'retry-now' };

    // A write may only be repeated when the server says it did not happen.
    case 'UNAVAILABLE':
      if (kind !== 'read' && error.writeOutcome !== 'not_applied') return { action: 'fail' };
      return backoff(input);

    // The server's OVERLOADED is a connection-level refusal (zero request ID) that serves nothing, so
    // every kind may wait it out. One that answers a request by its ID may have applied it: a write
    // (data or DDL) is not resent unless the server stamped what happened (a stamp is handled above
    // or means nothing was applied), because the table never repeats a write it cannot prove unapplied.
    case 'OVERLOADED':
      if (responseStarted && input.answersRequest === true && kind !== 'read' && error.writeOutcome === undefined) {
        return { action: 'fail' };
      }
      return backoff(input);

    default:
      return { action: 'fail' };
  }
}

/**
 * Whether the caller may repeat the whole call. True exactly for the rows the table retries for
 * this kind, so a program looping on `retryable` cannot repeat something the driver refused to.
 */
export function retryableFor(error: HoardDBError, kind: CallKind): boolean {
  if (error.writeOutcome === 'unknown') return false;

  switch (error.code) {
    case 'OVERLOADED':
      return true;
    // A connection that failed before anything was written (a failed dial, a closed socket) left
    // nothing to duplicate: the driver does not repeat a write itself, but the caller safely may.
    case 'CONNECTION_FAILED':
      return kind === 'read' || error.writeOutcome === 'not_applied';
    case 'NOT_AUTHENTICATED':
      return kind === 'read';
    case 'UNAVAILABLE':
      return kind === 'read' || error.writeOutcome === 'not_applied';
    default:
      return false;
  }
}
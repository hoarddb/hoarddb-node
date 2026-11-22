// SPDX-License-Identifier: Apache-2.0
//
// The answers the server gives in band, with success or found set to false, which are not errors on
// the wire: a miss is a successful frame (handbook errors.md section 3). Each verb reads the answer
// through these, so "nothing there" becomes [] (a list verb) or NotFoundError (a single value) and a refusal becomes InvalidArgumentError
// carrying the server's sentence verbatim.

import { InvalidArgumentError, NotFoundError, type ErrorContext, type HoardDBError, type WriteOutcome } from './errors.js';
import type { Stored, WriteResult } from './types.js';

/** The in-band messages that mean a read found nothing (vectors "get of a key that does not exist" and the queue vectors). */
export const MISS_MESSAGES: readonly string[] = ['document not found', 'queue is empty', 'heap is empty'];

/** Sent with success: false by a batch the server refused whole; the driver halves and resends (D-20). */
export const BATCH_NOTHING_WRITTEN = 'none of it was written';

const BLOB_MISS = /^blob ".*" not found in /;
const DELETE_MISSES: readonly string[] = ['document not found', 'blob not found'];
const UPDATE_MISS = /^document ".*" not found in /;

/** The message of an in-band answer, or the empty string when it carried none. */
export function messageOf(answer: Record<string, unknown>): string {
  const message = answer['message'];
  return typeof message === 'string' ? message : '';
}

/** The write outcome an answer reports, when it reports one. */
export function writeOutcomeOf(answer: Record<string, unknown>): WriteOutcome | undefined {
  const outcome = answer['write_outcome'];
  return outcome === 'applied' || outcome === 'not_applied' || outcome === 'unknown' ? outcome : undefined;
}

/** A read that found nothing: found false with no message, an empty one, or one of the miss sentences. */
export function isMiss(answer: Record<string, unknown>): boolean {
  if (answer['found'] !== false) return false;
  const message = messageOf(answer);
  return message === '' || MISS_MESSAGES.includes(message) || BLOB_MISS.test(message);
}

/** A delete that removed nothing: the missing sentences, or a document a condition spared or skipped. */
export function isDeleteMiss(answer: Record<string, unknown>): boolean {
  if (answer['spared'] === true || answer['skipped'] === true) return true;
  return answer['success'] === false && DELETE_MISSES.includes(messageOf(answer));
}

/** An update of a key that does not exist (vector "update of a key that does not exist"). */
export function isUpdateMiss(answer: Record<string, unknown>): boolean {
  return answer['success'] === false && UPDATE_MISS.test(messageOf(answer));
}

/** A refusal the server gave in band: InvalidArgumentError, its message verbatim, the answer's outcome. */
export function inbandRefusal(answer: Record<string, unknown>, ctx: ErrorContext): HoardDBError {
  return new InvalidArgumentError({
    message: messageOf(answer),
    operation: ctx.operation,
    target: ctx.target,
    requestId: ctx.requestId,
    writeOutcome: writeOutcomeOf(answer),
  });
}

// The readers below turn an answer into a result, or check an argument before anything is sent. Buckets and
// store fields share them, so they live with the in-band answers.

/** The write result an answer carries: the id, the sequence and the copies, each when present. */
export function writeResultOf(answer: Record<string, unknown>): WriteResult {
  const result: WriteResult = { id: answer['id'] as string };
  if (answer['seq'] !== undefined) result.seq = answer['seq'] as number | bigint;
  if (answer['copies_confirmed'] !== undefined) result.copiesConfirmed = Number(answer['copies_confirmed']);
  if (answer['replication_factor'] !== undefined) result.replicationFactor = Number(answer['replication_factor']);
  return result;
}

/** A priority must be a whole number (heap buckets; default 0). */
export function priorityOf(priority: number | bigint, target: string): bigint {
  if (typeof priority === 'bigint') return priority;
  if (!Number.isInteger(priority)) {
    throw new InvalidArgumentError({
      message: `priority must be a whole number, got ${String(priority)}: pass { priority: 1 } or leave it out for 0.`,
      operation: 'push',
      target,
      writeOutcome: 'not_applied',
    });
  }
  return BigInt(priority);
}

/** A peek takes one to a thousand items (default 1). */
export function peekLimitOf(limit: number | undefined, target: string): number {
  const chosen = limit ?? 1;
  if (!Number.isInteger(chosen) || chosen < 1 || chosen > 1000) {
    throw new InvalidArgumentError({
      message: `peek limit must be a whole number from 1 to 1000, got ${String(limit)}: pass { limit: 10 } or leave it out for 1.`,
      operation: 'peek',
      target,
    });
  }
  return chosen;
}

/** A pop takes one to a hundred entries; the field is left off the wire when the caller gave none. */
export function popLimitOf(limit: number | undefined, target: string): number | undefined {
  if (limit === undefined) return undefined;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new InvalidArgumentError({
      message: `pop limit must be a whole number from 1 to 100, got ${String(limit)}: pass { limit: 10 } or leave it out for 1. A pop removes what it returns, so for more than 100 repeat the pop, or read them without removing any with peek({ limit: 1000 }).`,
      operation: 'pop',
      target,
      writeOutcome: 'not_applied',
    });
  }
  return limit;
}

/**
 * A single-value verb found nothing: NotFoundError, so a miss and a stored null are never confused.
 * A verb that returns a list answers [] instead and never calls this.
 */
export function notFound(ctx: ErrorContext, message: string, hint: string): NotFoundError {
  return new NotFoundError({ message, operation: ctx.operation, target: ctx.target, requestId: ctx.requestId, hint });
}

/** The document a found answer carries; a miss is NotFoundError and any other answer is refused in band. */
export function foundOrThrow<T extends object>(answer: Record<string, unknown>, ctx: ErrorContext): Stored<T> {
  if (answer['found'] === true) return answer['data'] as Stored<T>;
  if (isMiss(answer)) {
    throw notFound(
      ctx,
      `Document ${String(ctx.target)} not found.`,
      'Check the key with find(), or create it with put(key, doc). A caller that expects the key may be absent catches NotFoundError.',
    );
  }
  throw inbandRefusal(answer, ctx);
}

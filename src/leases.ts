// SPDX-License-Identifier: Apache-2.0
//
// The lease and dead-list verbs' arguments and answers (handbook operations.md "Leases and the dead
// list", errors.md sections 3 and 6). Arguments are checked here, before anything is sent, because the
// server's refusal of a bad one is the same and a round trip later. The limits are the frozen
// consume-constants.json; test/unit/consume.test.ts holds them against it.

import {
  ClaimEntryTooLargeError,
  DeadMoveRefusedError,
  InvalidArgumentError,
  LeaseExpiredError,
  LeaseUnknownError,
  ProtocolError,
  isHoardDBError,
  type HoardDBError,
} from './errors.js';
import { inbandRefusal, messageOf, writeOutcomeOf } from './inband.js';
import type { AckResult, DeadEntry, DeadMoveResult, DeadPage, DeadSelector, ReleaseResult } from './types.js';

export const CLAIM_LIMIT_MAX = 100;
export const LEASE_MS_MIN = 1_000;
export const LEASE_MS_MAX = 3_600_000;
export const ACK_ITEM_IDS_MAX = 100;
export const DEAD_LIST_LIMIT_MAX = 1_000;

const LEASE_ID = /^[0-9a-f]{40}$/i;

function refused(operation: string, target: string, message: string): InvalidArgumentError {
  return new InvalidArgumentError({ message: `${message} Nothing was sent.`, operation, target, writeOutcome: 'not_applied' });
}

/** A claim takes one to a hundred entries; the field is left off the wire when the caller gave none. */
export function claimLimitOf(limit: number | undefined, operation: string, target: string): number | undefined {
  if (limit === undefined) return undefined;
  if (!Number.isInteger(limit) || limit < 1 || limit > CLAIM_LIMIT_MAX) {
    throw refused(
      operation,
      target,
      `${operation} limit must be a whole number from 1 to ${CLAIM_LIMIT_MAX}, got ${String(limit)}: pass { limit: 10 } or leave it out for 1; claim again for more.`,
    );
  }
  return limit;
}

/** A lease is 1 second to 1 hour, in milliseconds; absent means the server's 30 s. */
export function leaseMsOf(lease: number | undefined, operation: string, target: string): number | undefined {
  if (lease === undefined) return undefined;
  if (!Number.isInteger(lease) || lease < LEASE_MS_MIN || lease > LEASE_MS_MAX) {
    throw refused(
      operation,
      target,
      `${operation} lease must be a whole number of milliseconds from ${LEASE_MS_MIN} (1 s) to ${LEASE_MS_MAX} (1 h), got ${String(lease)}: extend a running lease with delivery.extend(ms) instead of claiming longer.`,
    );
  }
  return lease;
}

/** A lease id is the 40 hexadecimal characters claim answered; it goes on the wire lower-case. */
export function leaseIdOf(leaseId: string, operation: string, target: string): string {
  if (typeof leaseId !== 'string' || !LEASE_ID.test(leaseId)) {
    throw refused(
      operation,
      target,
      `${JSON.stringify(leaseId)} is not a lease id: a lease id is the 40 hexadecimal characters claim() returns in leaseId. Claim again and keep the id it returns.`,
    );
  }
  return leaseId.toLowerCase();
}

/** An ack names at most 100 item ids; none at all (the option left out) settles the whole lease. */
export function itemIdsOf(itemIds: readonly string[] | undefined, target: string): string[] | undefined {
  if (itemIds === undefined) return undefined;
  if (itemIds.length === 0) {
    throw refused('ack', target, 'itemIds needs at least one id; leave the option out to acknowledge the whole lease.');
  }
  if (itemIds.length > ACK_ITEM_IDS_MAX) {
    throw refused('ack', target, `itemIds names ${itemIds.length} ids; an ack names at most ${ACK_ITEM_IDS_MAX}, so ack in groups.`);
  }
  return [...itemIds];
}

/** A dead list shows one to a thousand entries; absent means the server's 10. */
export function deadLimitOf(limit: number | undefined, target: string): number | undefined {
  if (limit === undefined) return undefined;
  if (!Number.isInteger(limit) || limit < 1 || limit > DEAD_LIST_LIMIT_MAX) {
    throw refused(
      'deadList',
      target,
      `deadList limit must be a whole number from 1 to ${DEAD_LIST_LIMIT_MAX}, got ${String(limit)}: page with { after } for more.`,
    );
  }
  return limit;
}

/** The wire members of a requeue or discard selector: one dead id, or all (with an optional after). */
export function selectorFields(selector: DeadSelector, operation: string, target: string): Record<string, unknown> {
  const named = selector as { byId?: unknown; all?: unknown; after?: unknown };
  const byId = named.byId;
  const all = named.all === true;
  if ((byId === undefined) === !all || (byId !== undefined && (typeof byId !== 'string' || byId === ''))) {
    throw refused(
      operation,
      target,
      `${operation} needs a selector that names one dead entry, { byId: '<deadId>' }, or all of them, { all: true }; not ${JSON.stringify(selector)}.`,
    );
  }
  const after = typeof named.after === 'string' && named.after !== '' ? named.after : undefined;
  return { dead_id: byId, all: all ? true : undefined, after };
}

function count(answer: Record<string, unknown>, name: string): number {
  return Number(answer[name] ?? 0);
}

/** An ack's result from an answer; counts the server left out are 0. */
export function ackResultOf(answer: Record<string, unknown>): AckResult {
  return {
    state: String(answer['lease_state'] ?? ''),
    acked: count(answer, 'acked'),
    missing: count(answer, 'missing'),
    remaining: count(answer, 'remaining'),
    message: messageOf(answer),
  };
}

export function releaseResultOf(answer: Record<string, unknown>): ReleaseResult {
  return { state: String(answer['lease_state'] ?? ''), released: count(answer, 'released'), message: messageOf(answer) };
}

/**
 * The error of a lease verb's in-band `success: false`. An unknown or expired lease is its own class and
 * carries the result; anything else is the refusal it says it is. The write outcome is the answer's own
 * and is never `not_applied` for these two states: the same apply may have returned other expired leases.
 */
export function leaseFailure(
  answer: Record<string, unknown>,
  operation: string,
  target: string,
  result: AckResult | ReleaseResult,
): HoardDBError {
  const init = { message: messageOf(answer), operation, target, writeOutcome: writeOutcomeOf(answer), result };
  switch (answer['lease_state']) {
    case 'unknown':
      return new LeaseUnknownError(init);
    case 'expired':
      return new LeaseExpiredError(init);
    default:
      return inbandRefusal(answer, { operation, target });
  }
}

/** The one claim refusal the codes do not class: the hard cap, INVALID_ARGUMENT starting "claim refused". */
export function claimFailure(error: unknown): unknown {
  if (isHoardDBError(error) && error.code === 'INVALID_ARGUMENT' && error.message.startsWith('claim refused')) {
    return new ClaimEntryTooLargeError({
      message: error.message,
      wireCode: error.wireCode,
      operation: error.operation,
      target: error.target,
      requestId: error.requestId,
      retryable: false,
      writeOutcome: error.writeOutcome,
      copiesConfirmed: error.copiesConfirmed,
      replicationFactor: error.replicationFactor,
      cause: error,
    });
  }
  return error;
}

/** An answer whose parallel lists do not line up: the driver and the server disagree about its shape. */
export function unreadableClaim(answer: Record<string, unknown>, target: string): ProtocolError {
  const lengths = ['items', 'item_ids', 'deliveries'].map((name) => `${String((answer[name] as unknown[] | undefined)?.length ?? 0)} ${name}`);
  return new ProtocolError({
    message: `The server's claim answer is not one this driver can read: ${lengths.join(', ')} and lease id ${JSON.stringify(answer['lease_id'])}. This driver and the server disagree about its shape; upgrade the driver.`,
    operation: 'claim',
    target,
  });
}

/** The dead page an answer carries; found false with a message is a refusal, never "no dead entries". */
export function deadPageOf<T extends object>(answer: Record<string, unknown>, target: string): DeadPage<T> {
  if (answer['found'] !== true) {
    if (messageOf(answer) !== '') throw inbandRefusal(answer, { operation: 'deadList', target });
    return { items: [] };
  }
  const raw = (answer['items'] ?? []) as Record<string, unknown>[];
  const items = raw.map(
    (entry): DeadEntry<T> => ({
      deadId: String(entry['dead_id']),
      document: (entry['data'] ?? {}) as T,
      deliveries: Number(entry['deliveries'] ?? 0),
      deadAt: entry['dead_at'] as Date,
      reason: String(entry['reason'] ?? ''),
    }),
  );
  const next = answer['next'];
  return typeof next === 'string' && next !== '' ? { items, next } : { items };
}

/** The result of a requeue or discard, and the error when the server refused some or all of it. */
export function deadMoveOf(answer: Record<string, unknown>, operation: string, target: string): DeadMoveResult {
  const refusals = ((answer['refused'] ?? []) as Record<string, unknown>[]).map((entry) => ({
    deadId: String(entry['dead_id']),
    message: String(entry['message'] ?? ''),
  }));
  const result: DeadMoveResult = { done: count(answer, 'done'), left: count(answer, 'left'), refused: refusals, message: messageOf(answer) };
  if (answer['success'] === true) return result;
  // The server's own sentence, else the refusals it named, verbatim.
  const message =
    result.message !== ''
      ? result.message
      : refusals.length > 0
        ? refusals.map((refusal) => refusal.message).join('\n')
        : `the server refused the request and moved ${result.done} entries`;
  throw new DeadMoveRefusedError({ message, operation, target, writeOutcome: writeOutcomeOf(answer), result });
}


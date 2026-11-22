// SPDX-License-Identifier: Apache-2.0
//
// What the lease and dead-list tests share: a lease id, the answers a server gives (the shapes the
// frozen vectors pin), and a vector's request with its normalised lease id put back.

import assert from 'node:assert/strict';

import { extendedJsonFromBytes } from '../../src/codec/index.js';
import { assertRequestMatches } from './compare.js';
import type { RecordedRequest } from './recording.js';
import type { Vector } from './vectors.js';

/** A lease id as the server mints it: 40 hexadecimal characters. */
export const LEASE = '0123456789abcdef0123456789abcdef01234567';

/** What a claim of `count` entries answers (handbook operations.md, claim). */
export function claimAnswer(
  count: number,
  extra: { leaseMs?: number; deliveries?: number[]; returned?: number; dead?: number } = {},
): Record<string, unknown> {
  const answer: Record<string, unknown> = {
    found: true,
    items: Array.from({ length: count }, (_, position) => ({ Name: `entry-${position}`, _id_: `id-${position}` })),
    item_ids: Array.from({ length: count }, (_, position) => String(position).padStart(16, '0')),
    lease_id: LEASE,
    lease_ms: BigInt(extra.leaseMs ?? 30_000),
    pending: BigInt(count),
    message: '',
  };
  if (extra.deliveries !== undefined) answer['deliveries'] = extra.deliveries;
  if (extra.returned !== undefined) answer['returned'] = BigInt(extra.returned);
  if (extra.dead !== undefined) answer['dead'] = BigInt(extra.dead);
  return answer;
}

/** The answer of a claim that took nothing. */
export const EMPTY_CLAIM: Record<string, unknown> = { found: false, message: 'queue is empty' };

/** An ack, release or extend answer. */
export function leaseAnswer(fields: Record<string, unknown>): Record<string, unknown> {
  return { success: true, ...fields };
}

/** The request a verb sent matches the vector's, with the vector's normalised lease id replaced by `lease`. */
export function assertSentWithLease(sent: RecordedRequest | undefined, vector: Vector, lease: string = LEASE): void {
  const request = vector['request'] as { opcode_name: string; payload_json: Record<string, unknown>; allowed_fields: string[] };
  assert.ok(sent !== undefined, `${vector.name}: no request was recorded`);
  assert.equal(sent.op, request.opcode_name, `${vector.name}: the opcode`);
  const expected = { ...request.payload_json };
  if (expected['lease_id'] === 'normalised') expected['lease_id'] = lease;
  assertRequestMatches(extendedJsonFromBytes(sent.bytes), expected, request.allowed_fields);
}

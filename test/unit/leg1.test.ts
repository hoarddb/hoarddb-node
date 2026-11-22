// SPDX-License-Identifier: Apache-2.0
//
// Leg 1: every wire field name, pinned by the frozen vectors. A guessed name fails silently
// (`writeconcern` is one word), so the tables in src/wire/messages.ts are checked against the
// vectors in both directions, and the decoders are checked against the answers the server really
// wrote: an unknown field, another integer width and a value that is not there at all must all
// decode (handbook testing.md section 1).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  bytesFromExtendedJson,
  extendedJsonFromBytes,
  valuesFromExtendedJson,
} from '../../src/codec/index.js';
import { InvalidArgumentError } from '../../src/errors.js';
import {
  decodeResponse,
  encodeRequest,
  REQUEST_FIELDS,
} from '../../src/wire/messages.js';
import type { OpName } from '../../src/wire/opcodes.js';
import { assertRequestMatches } from '../helpers/compare.js';
import { hexToBytes, vectorsOfKind, type Vector } from '../helpers/vectors.js';

interface Exchange {
  vector: Vector;
  /** The request opcode, when the table models one. */
  op: OpName;
}

interface ExchangeRequest extends Exchange {
  payload: Record<string, unknown>;
  allowed: readonly string[];
}

interface ExchangeAnswer extends Exchange {
  name: string;
  bytes: Uint8Array;
  fields: readonly string[];
}

const INT32_MIN = -2147483648;
const INT32_MAX = 2147483647;

function exchanges(): Vector[] {
  return vectorsOfKind('exchange');
}

function opOf(vector: Vector): OpName | undefined {
  const name = String((vector['request'] as { opcode_name: string }).opcode_name);
  return Object.hasOwn(REQUEST_FIELDS, name) ? (name as OpName) : undefined;
}

/** The exchanges whose request the driver builds: one with a payload and an opcode in the table. */
function exchangeRequests(): ExchangeRequest[] {
  const requests: ExchangeRequest[] = [];
  for (const vector of exchanges()) {
    const op = opOf(vector);
    if (op === undefined) continue;
    const request = vector['request'] as { payload_json?: Record<string, unknown>; allowed_fields: string[] };
    if (request.payload_json === undefined) continue;
    requests.push({
      vector,
      op,
      payload: request.payload_json,
      allowed: request.allowed_fields,
    });
  }
  return requests;
}

/** The answers a typed decoder must read: a real payload that is neither an ERROR nor an AUTH_FAIL. */
function exchangeAnswers(): ExchangeAnswer[] {
  const answers: ExchangeAnswer[] = [];
  for (const vector of exchanges()) {
    const op = opOf(vector);
    if (op === undefined) continue;
    const response = vector['response'] as {
      opcode_name: string;
      payload_json?: Record<string, unknown>;
      payload_hex?: string;
    };
    if (response.payload_json === undefined || response.payload_hex === undefined) continue;
    if (response.opcode_name === 'ERROR' || response.opcode_name === 'AUTH_FAIL') continue;
    answers.push({
      vector,
      op,
      name: String(vector['name']),
      bytes: hexToBytes(response.payload_hex),
      fields: Object.keys(response.payload_json),
    });
  }
  return answers;
}

function fitsInt32(text: string): boolean {
  const digits = BigInt(text);
  return digits >= BigInt(INT32_MIN) && digits <= BigInt(INT32_MAX);
}

/** An Extended JSON tree whose every integer is written as the width a decoder must also accept. */
function rewriteIntegerWidths(value: unknown, from: string, to: string, rewrite: (digits: string) => boolean): unknown {
  if (Array.isArray(value)) return value.map((entry) => rewriteIntegerWidths(entry, from, to, rewrite));
  if (typeof value !== 'object' || value === null) return value;
  const entries = Object.entries(value as Record<string, unknown>);
  const [head, ...rest] = entries;
  if (head !== undefined && rest.length === 0) {
    const [name, digits] = head;
    if (name === from && typeof digits === 'string' && rewrite(digits)) {
      return { [to]: digits };
    }
  }
  const rewritten: Record<string, unknown> = {};
  for (const [key, entry] of entries) {
    rewritten[key] = rewriteIntegerWidths(entry, from, to, rewrite);
  }
  return rewritten;
}

const ALWAYS = (): boolean => true;

function widenIntegers(value: unknown): unknown {
  return rewriteIntegerWidths(value, '$numberInt', '$numberLong', ALWAYS);
}

function narrowIntegers(value: unknown): unknown {
  return rewriteIntegerWidths(value, '$numberLong', '$numberInt', fitsInt32);
}

test('every exchange request re-encodes within allowed_fields', () => {
  const requests = exchangeRequests();
  for (const { vector, op, payload, allowed } of requests) {
    const fields = valuesFromExtendedJson(payload, 'bigint');
    const bytes = encodeRequest(op, fields);
    try {
      assertRequestMatches(extendedJsonFromBytes(bytes), payload, allowed);
    } catch (error) {
      assert.fail(`the ${String(vector['name'])} vector (${op}): ${(error as Error).message}`);
    }
  }
  console.log(`leg 1 requests: ${requests.length} vectors`);
});

test("REQUEST_FIELDS equals every vector's allowed_fields", () => {
  const allowedByOp = new Map<string, Set<string>>();
  for (const vector of exchanges()) {
    const request = vector['request'] as { opcode_name: string; allowed_fields: string[] };
    const name = request.opcode_name;
    if (!Object.hasOwn(REQUEST_FIELDS, name)) continue;
    const union = allowedByOp.get(name) ?? new Set<string>();
    for (const field of request.allowed_fields) union.add(field);
    allowedByOp.set(name, union);
  }
  for (const [op, fields] of Object.entries(REQUEST_FIELDS)) {
    const union = allowedByOp.get(op);
    assert.ok(union !== undefined, `no exchange vector exercises ${op}`);
    const typed = [...(fields ?? [])].sort();
    assert.deepEqual([...union].sort(), typed, `REQUEST_FIELDS.${op} does not match the vectors`);
  }
});

test('every success response decodes', () => {
  const answers = exchangeAnswers();
  for (const { name, op, bytes, fields } of answers) {
    const decoded = decodeResponse(op, bytes, 'safe');
    for (const field of fields) {
      assert.ok(Object.hasOwn(decoded, field), `the ${name} answer does not carry "${field}"`);
    }
  }
});

test('decoders tolerate an unknown field', () => {
  for (const { name, op, bytes } of exchangeAnswers()) {
    const extended = extendedJsonFromBytes(bytes);
    extended['zz_new_field'] = 'a field this driver has never heard of';
    const decoded = decodeResponse(op, bytesFromExtendedJson(extended), 'safe');
    assert.equal(decoded['zz_new_field'], 'a field this driver has never heard of', name);
  }
});

test('decoders tolerate int32 and int64 for every integer', () => {
  for (const { name, op, bytes, fields } of exchangeAnswers()) {
    const asExtended = extendedJsonFromBytes(bytes);
    const widened = decodeResponse(op, bytesFromExtendedJson(widenIntegers(asExtended)), 'safe');
    const narrowed = decodeResponse(op, bytesFromExtendedJson(narrowIntegers(asExtended)), 'safe');
    for (const decoded of [widened, narrowed]) {
      for (const field of fields) {
        assert.ok(Object.hasOwn(decoded, field), `the ${name} answer lost "${field}"`);
      }
    }
  }
});

test('encodeRequest refuses a field the op does not have', () => {
  assert.throws(
    () =>
      encodeRequest('PUT', {
        database: 'a',
        bucket: 'b',
        key: 'k',
        data: {},
        write_concern: 'all',
      }),
    (error: unknown) => {
      assert.ok(error instanceof InvalidArgumentError, `expected an InvalidArgumentError, got ${String(error)}`);
      assert.ok(
        error.message.includes('write_concern'),
        `the refusal does not name the field: ${error.message}`,
      );
      assert.ok(
        error.message.includes('PUT has no wire field'),
        `the refusal does not name the operation: ${error.message}`,
      );
      return true;
    },
  );
});
test('a request check tells an int32 from an int64 where the vector pins the width', () => {
  // A response's integer width is the server's choice; a request's is the driver's encoding, and a
  // vector that pins int64 (a heap priority, expect_bucket_id, protocol_version) must not be met by an
  // int32. Before this check both normalised to the same value and the shape tests could not tell.
  const allowed = ['priority'];
  assert.throws(
    () => assertRequestMatches({ priority: { $numberInt: '5' } }, { priority: { $numberLong: '5' } }, allowed),
    /the request field "priority" differs/,
  );
  assertRequestMatches({ priority: { $numberLong: '5' } }, { priority: { $numberLong: '5' } }, allowed);
  assertRequestMatches({ priority: { $numberInt: '5' } }, { priority: { $numberInt: '5' } }, allowed);
});

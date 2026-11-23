// SPDX-License-Identifier: Apache-2.0
//
// The error model is proven against the frozen vectors: a refusal keeps the server's sentence
// byte for byte, code 0 is never a success, and the two connection rules (isConnectionFatal,
// keepsConnection) are read off the capture rather than guessed.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { encodeDocument } from '../../src/codec/index.js';

import { decideRetry, retryableFor } from '../../src/retry.js';
import { hexToBytes, vectorNamed, vectorsOfKind, type Vector } from '../helpers/vectors.js';
import { decodeFrame, encodeFrame, newRequestId } from '../../src/wire/frame.js';
import { Op } from '../../src/wire/opcodes.js';
import {
  AbortedError,
  AlreadyExistsError,
  AuthenticationError,
  BatchTooLargeError,
  ClientClosedError,
  ConfigError,
  ConflictError,
  ConnectionError,
  DocumentExistsError,
  DuplicateKeyError,
  FieldTypeError,
  FrameTooLargeError,
  HoardDBError,
  InternalError,
  InvalidArgumentError,
  NotAuthenticatedError,
  NotFoundError,
  OverloadedError,
  PermissionDeniedError,
  PoolTimeoutError,
  ProtocolError,
  QuotaExceededError,
  RequestTimeoutError,
  ResultTooLargeError,
  TlsTrustError,
  UnavailableError,
  UnreadableValueError,
  UnsupportedFeatureError,
  UnsupportedVersionError,
  WriteConcernTimeoutError,
  errorFromAuthFail,
  errorFromErrorPayload,
  isConnectionFatal,
  isHoardDBError,
  keepsConnection,
  type ErrorContext,
  type ErrorInit,
} from '../../src/errors.js';

interface DecodeExpect {
  result: string;
  code?: number;
  name?: string;
  request_id_zero?: boolean;
  connection_fatal?: boolean;
  message_contains?: string[];
}

interface ErrorExchange extends Vector {
  response: {
    opcode_name: string;
    payload_hex: string;
    payload_json: { message?: string; [field: string]: unknown };
  };
  error?: { code: number; name: string; write_outcome?: string };
}

const CTX: ErrorContext = { operation: 'put', target: 'app/users/ada', requestId: 'aabb', kind: 'write' };

const BATCH_MESSAGE =
  'batch too large: 300 documents and 21.0 MiB are over the 100000-entry and 20 MiB batch limits; halve the batch and resend each half';

/** An ERROR frame the way the server sends one, decoded back to the payload the driver reads. */
function batchTooLargeError(writeOutcome: 'not_applied' | 'unknown'): HoardDBError {
  const payload = encodeDocument({ code: 17, message: BATCH_MESSAGE, write_outcome: writeOutcome });
  const frame = decodeFrame(encodeFrame({ opcode: Op.ERROR, requestId: newRequestId(), payload }));
  return errorFromErrorPayload(frame.payload, CTX);
}

function payloadOf(vector: Vector): Uint8Array {
  return decodeFrame(hexToBytes(String(vector.frame_hex))).payload;
}

function decodeVectorsWith(expect: (check: DecodeExpect) => boolean): Vector[] {
  return vectorsOfKind('decode').filter((vector) => expect(vector.expect as DecodeExpect));
}

function errorDecodeVectors(): Vector[] {
  return decodeVectorsWith((expect) => expect.result === 'error');
}

function authFailDecodeVectors(): Vector[] {
  return decodeVectorsWith((expect) => expect.result === 'auth_fail');
}

function errorExchangeVectors(): ErrorExchange[] {
  return vectorsOfKind('exchange').filter(
    (vector) =>
      vector.group === 'errors' &&
      (vector as ErrorExchange).response !== undefined &&
      (vector as ErrorExchange).response.opcode_name === 'ERROR',
  ) as ErrorExchange[];
}

function errorFromExchange(vector: ErrorExchange): HoardDBError {
  return errorFromErrorPayload(hexToBytes(vector.response.payload_hex), {
    operation: 'put',
    target: 'app/users/ada',
    kind: 'write',
  });
}

test('every decode vector with result error maps to its code', () => {
  const vectors = errorDecodeVectors();
  assert.ok(vectors.length >= 10, `expected at least 10 error decode vectors, found ${vectors.length}`);

  for (const vector of vectors) {
    const expect = vector.expect as DecodeExpect;
    const error = errorFromErrorPayload(payloadOf(vector), CTX);
    assert.equal(error.code, expect.name, `${vector.name}: code`);
    assert.equal(error.wireCode, expect.code, `${vector.name}: wire code`);
    for (const fragment of expect.message_contains ?? []) {
      assert.ok(error.message.includes(fragment), `${vector.name}: message holds ${fragment}: ${error.message}`);
    }
  }
});

test('connection_fatal matches every decode vector', () => {
  const vectors = decodeVectorsWith((expect) => typeof expect.connection_fatal === 'boolean');
  assert.ok(vectors.length >= 10, `expected at least 10 vectors with connection_fatal, found ${vectors.length}`);

  for (const vector of vectors) {
    const expect = vector.expect as DecodeExpect;
    const requestIdZero = expect.request_id_zero === true;
    const error = errorFromErrorPayload(payloadOf(vector), CTX);
    assert.equal(
      isConnectionFatal(error, requestIdZero),
      expect.connection_fatal,
      `${vector.name}: connection_fatal`,
    );
  }
});

test('every decode vector with result auth_fail maps to its reason', () => {
  const vectors = authFailDecodeVectors();
  assert.ok(vectors.length >= 3, `expected at least 3 auth_fail vectors, found ${vectors.length}`);

  for (const vector of vectors) {
    const expect = vector.expect as DecodeExpect;
    const error = errorFromAuthFail(payloadOf(vector), CTX);
    assert.equal(error.reason, expect.name, `${vector.name}: reason`);
    assert.ok(error instanceof AuthenticationError, `${vector.name}: an AuthenticationError`);
  }
});

test('an empty AUTH_FAIL payload is CREDENTIALS', () => {
  const vector = vectorNamed('auth refused with an empty payload');
  const payload = payloadOf(vector);
  assert.equal(payload.length, 0, `${vector.name}: the payload really is empty`);

  const error = errorFromAuthFail(payload, CTX);
  assert.equal(error.reason, 'CREDENTIALS', `${vector.name}: reason`);
  assert.equal(error.retryable, false, `${vector.name}: never retried`);
});

test('every errors-group exchange vector maps to its class', () => {
  const vectors = errorExchangeVectors();
  assert.ok(vectors.length >= 15, `expected at least 15 ERROR exchanges, found ${vectors.length}`);

  for (const vector of vectors) {
    const expected = vector.error;
    assert.ok(expected !== undefined, `${vector.name}: the vector carries an error block`);
    const error = errorFromExchange(vector);
    assert.equal(error.code, expected.name, `${vector.name}: code`);
    assert.equal(error.wireCode, expected.code, `${vector.name}: wire code`);
    if (expected.write_outcome !== undefined) {
      assert.equal(error.writeOutcome, expected.write_outcome, `${vector.name}: write outcome`);
    }
  }
});

test('the server message is verbatim', () => {
  const vectors = errorExchangeVectors();
  assert.ok(vectors.length >= 15, `expected at least 15 ERROR exchanges, found ${vectors.length}`);

  for (const vector of vectors) {
    const error = errorFromExchange(vector);
    assert.equal(error.message, vector.response.payload_json.message, `${vector.name}: message`);
  }
});

test('code 0 and a missing code are INTERNAL, never success', () => {
  for (const name of ['error with code 0', 'error with no code']) {
    const vector = vectorNamed(name);
    const error = errorFromErrorPayload(payloadOf(vector), CTX);
    assert.equal(error.code, 'INTERNAL', `${name}: code`);
    assert.equal(error.wireCode, 0, `${name}: wire code 0`);
    assert.ok(error instanceof InternalError, `${name}: an InternalError`);
    assert.notEqual(error.code, 'OK', `${name}: never a success`);
  }
});

test('RESULT_TOO_LARGE carries both numbers', () => {
  const vector = vectorNamed('result too large with its two numbers');
  const error = errorFromErrorPayload(payloadOf(vector), CTX);
  assert.ok(error instanceof ResultTooLargeError, `${vector.name}: a ResultTooLargeError`);
  assert.equal(typeof error.maxResultBytes, 'number', `${vector.name}: max_result_bytes is a number`);
  assert.equal(typeof error.retainedBytes, 'number', `${vector.name}: retained_bytes is a number`);
});

test('TIMEOUT carries writeOutcome applied', () => {
  const vector = vectorNamed('write concern not met in time');
  const error = errorFromErrorPayload(payloadOf(vector), CTX);
  assert.ok(error instanceof WriteConcernTimeoutError, `${vector.name}: a WriteConcernTimeoutError`);
  assert.equal(error.code, 'TIMEOUT', `${vector.name}: code`);
  assert.equal(error.writeOutcome, 'applied', `${vector.name}: the write is stored`);
  assert.equal(error.copiesConfirmed, 1, `${vector.name}: copies_confirmed`);
  assert.equal(error.replicationFactor, 3, `${vector.name}: replication_factor`);
});

test('isHoardDBError recognises a branded object from another copy of the class', () => {
  const branded = { [Symbol.for('hoarddb.error')]: true, code: 'INTERNAL' };
  assert.equal(isHoardDBError(branded), true, 'a branded plain object');
  assert.equal(isHoardDBError(new NotFoundError({ message: 'gone', operation: 'get' })), true, 'an instance');
  assert.equal(isHoardDBError(new Error('plain')), false, 'a plain Error');
  assert.equal(isHoardDBError(null), false, 'null');
  assert.equal(isHoardDBError({ code: 'INTERNAL' }), false, 'a code without the brand');
});

test('toJSON leaves out the cause', () => {
  const init: ErrorInit = { message: 'a refusal', operation: 'put', cause: { password: 'pw-SECRET-1' } };
  const refusals: ReadonlyArray<readonly [string, HoardDBError]> = [
    ['HoardDBError', new HoardDBError('EARLY_DATA_REJECTED', init)],
    ['NotFoundError', new NotFoundError(init)],
    ['AlreadyExistsError', new AlreadyExistsError(init)],
    ['PermissionDeniedError', new PermissionDeniedError(init)],
    ['InvalidArgumentError', new InvalidArgumentError(init)],
    ['InternalError', new InternalError(init)],
    ['UnavailableError', new UnavailableError(init)],
    ['WriteConcernTimeoutError', new WriteConcernTimeoutError(init)],
    ['ConflictError', new ConflictError(init)],
    ['QuotaExceededError', new QuotaExceededError(init)],
    ['UnsupportedVersionError', new UnsupportedVersionError(init)],
    ['NotAuthenticatedError', new NotAuthenticatedError(init)],
    ['OverloadedError', new OverloadedError(init)],
    ['ResultTooLargeError', new ResultTooLargeError(init)],
    ['DuplicateKeyError', new DuplicateKeyError(init)],
    ['FieldTypeError', new FieldTypeError(init)],
    ['BatchTooLargeError', new BatchTooLargeError(init)],
    ['ConnectionError', new ConnectionError(init)],
    ['TlsTrustError', new TlsTrustError('TLS_KEY_CHANGED', init)],
    ['AuthenticationError', new AuthenticationError(init)],
    ['ProtocolError', new ProtocolError(init)],
    ['RequestTimeoutError', new RequestTimeoutError(init)],
    ['AbortedError', new AbortedError(init)],
    ['ClientClosedError', new ClientClosedError(init)],
    ['PoolTimeoutError', new PoolTimeoutError(init)],
    ['FrameTooLargeError', new FrameTooLargeError(init)],
    ['ConfigError', new ConfigError('INVALID_URI', init)],
    ['UnsupportedFeatureError', new UnsupportedFeatureError(init)],
    ['UnreadableValueError', new UnreadableValueError({ ...init, valueKind: 'datetime', field: 'when', document: 'ada' })],
  ];
  assert.equal(refusals.length, 29, 'one refusal of every class');

  for (const [name, error] of refusals) {
    const json = JSON.stringify(error);
    assert.ok(!json.includes('pw-SECRET-1'), `${name}: ${json}`);
    const keys = Object.keys(JSON.parse(json) as Record<string, unknown>);
    assert.equal(keys.includes('cause'), false, `${name}: toJSON has no cause key`);
  }
});

test('keepsConnection drops INTERNAL, UNKNOWN and zero-ID errors and keeps the rest', () => {
  const internal = errorFromErrorPayload(payloadOf(vectorNamed('error with code 0')), CTX);
  const unknown = errorFromErrorPayload(payloadOf(vectorNamed('error with a code the driver does not know')), CTX);
  const unauthenticated = errorFromErrorPayload(
    hexToBytes((vectorNamed('request before authentication') as ErrorExchange).response.payload_hex),
    CTX,
  );
  const notFound = errorFromExchange(vectorNamed('get of a bucket that does not exist') as ErrorExchange);

  assert.equal(keepsConnection(internal, false), false, 'INTERNAL');
  assert.equal(keepsConnection(unknown, false), false, 'UNKNOWN(99)');
  assert.equal(keepsConnection(unauthenticated, false), false, 'NOT_AUTHENTICATED');
  assert.equal(keepsConnection(notFound, true), false, 'a zero request ID');
  assert.equal(keepsConnection(notFound, false), true, 'NOT_FOUND');
});

test('an ERROR frame with code 17 is BATCH_TOO_LARGE with its write outcome', () => {
  for (const writeOutcome of ['not_applied', 'unknown'] as const) {
    const error = batchTooLargeError(writeOutcome);
    assert.equal(error.code, 'BATCH_TOO_LARGE', `${writeOutcome}: code`);
    assert.equal(error.wireCode, 17, `${writeOutcome}: wire code`);
    assert.ok(error instanceof BatchTooLargeError, `${writeOutcome}: a BatchTooLargeError`);
    assert.equal(error.writeOutcome, writeOutcome, `${writeOutcome}: write outcome carried as given`);
    assert.equal(error.message, BATCH_MESSAGE, `${writeOutcome}: the server's sentence is kept verbatim`);
  }
});

test('BATCH_TOO_LARGE is never retried and the connection is kept', () => {
  for (const writeOutcome of ['not_applied', 'unknown'] as const) {
    const error = batchTooLargeError(writeOutcome);
    assert.equal(error.retryable, false, `${writeOutcome}: the error is not retryable`);
    for (const kind of ['read', 'write', 'ddl'] as const) {
      assert.deepEqual(
        decideRetry({ error, kind, attempts: 1, responseStarted: true, remainingMs: 10_000, random: () => 0.5 }),
        { action: 'fail' },
        `${writeOutcome}: ${kind} is never retried`,
      );
      assert.equal(retryableFor(error, kind), false, `${writeOutcome}: ${kind} is not retryable`);
    }
    assert.equal(keepsConnection(error, false), true, `${writeOutcome}: the connection survives`);
  }
});

test('RESULT_TOO_LARGE without retained_bytes reports 0, not undefined', () => {
  // The server declares both numbers omitempty (the server's ErrorResponse): when the first
  // document alone is over the ceiling nothing is retained and retained_bytes is left out. Absent means 0.
  const message =
    'query result is over the node\'s 1048576-byte result ceiling: stopped at 0.0 MiB after 0 documents. Page smaller (limit), project fewer fields, or narrow the filter.';
  const withoutRetained = errorFromErrorPayload(encodeDocument({ code: 14, message, max_result_bytes: 1048576 }), CTX);
  assert.ok(withoutRetained instanceof ResultTooLargeError);
  assert.equal(withoutRetained.retainedBytes, 0);
  assert.equal(withoutRetained.maxResultBytes, 1048576);
  assert.equal(withoutRetained.message, message, "the server's sentence is kept verbatim");

  const withNeither = errorFromErrorPayload(encodeDocument({ code: 14, message }), CTX);
  assert.ok(withNeither instanceof ResultTooLargeError);
  assert.equal(withNeither.retainedBytes, 0);
  assert.equal(withNeither.maxResultBytes, 0);

  // Only RESULT_TOO_LARGE carries them: another code is not given numbers it never has.
  const notFound = errorFromErrorPayload(encodeDocument({ code: 1, message: 'bucket not found' }), CTX);
  assert.equal(notFound instanceof ResultTooLargeError, false);
  assert.equal((notFound as { retainedBytes?: number }).retainedBytes, undefined);
});

test('a document-exists refusal is typed', () => {
  // Wire code 0x12: a put, insert or insertMany named a key that holds a document. The bytes are the
  // server's own, from the frozen vector.
  const vector = vectorNamed('insert of an existing id is refused') as ErrorExchange;
  assert.equal(vector.response.opcode_name, 'ERROR');
  const error = errorFromErrorPayload(hexToBytes(vector.response.payload_hex), { operation: 'put', target: 'v297/users/ada', kind: 'write' });
  assert.ok(error instanceof DocumentExistsError, `DocumentExistsError, got ${error.name}`);
  assert.ok(!(error instanceof InternalError), 'a deliberate refusal is not an internal error');
  assert.equal(error.code, 'DOCUMENT_EXISTS');
  assert.equal(error.wireCode, 18);
  assert.equal(error.writeOutcome, 'not_applied');
  assert.equal(error.retryable, false);
  // The server's sentence is kept byte for byte; the hint is in this driver's own call syntax.
  assert.match(error.message, /^Document "ada" already exists in bucket "users" \(database "v297"\)\./);
  assert.match(error.hint ?? '', /upsert\(key, doc\)/);
  assert.match(error.hint ?? '', /update\(key, ops\)/);
  assert.equal(keepsConnection(error, false), true, 'a known refusal keeps its connection');

  // The same code with no vector behind it: any ERROR payload carrying 18.
  const bare = errorFromErrorPayload(encodeDocument({ code: 18, message: 'm' }), CTX);
  assert.ok(bare instanceof DocumentExistsError);
  assert.equal(bare.code, 'DOCUMENT_EXISTS');
});

// SPDX-License-Identifier: Apache-2.0
//
// The error model (build doc section 5, handbook/errors.md). One base class, one subclass
// per code, the server's sentence kept byte for byte with the driver's hint beside it. Code 0 and a
// missing code are INTERNAL: an ERROR frame is a refusal whatever it carries.
//
// The brand is a well-known symbol rather than an instanceof, so an error built by the other half
// of the dual build (or by an older copy) is still recognised.

import { decodeDocument } from './codec/index.js';
import type { AckResult, DeadMoveResult, ReleaseResult } from './types.js';
import type { FrameRefusal } from './wire/frame.js';

const ERROR_BRAND: unique symbol = Symbol.for('hoarddb.error');

/** Every code a caller can see, including the codes only the driver itself raises. */
export type ErrorCode =
  | 'NOT_FOUND'
  | 'ALREADY_EXISTS'
  | 'PERMISSION_DENIED'
  | 'INVALID_ARGUMENT'
  | 'INTERNAL'
  | 'UNAVAILABLE'
  | 'TIMEOUT'
  | 'CONFLICT'
  | 'QUOTA_EXCEEDED'
  | 'UNSUPPORTED_VERSION'
  | 'EARLY_DATA_REJECTED'
  | 'NOT_AUTHENTICATED'
  | 'OVERLOADED'
  | 'RESULT_TOO_LARGE'
  | 'DUPLICATE_KEY'
  | 'FIELD_TYPE'
  | 'BATCH_TOO_LARGE'
  | 'DOCUMENT_EXISTS'
  | 'CONNECTION_FAILED'
  | 'TLS_UNTRUSTED'
  | 'TLS_FINGERPRINT_MISMATCH'
  | 'TLS_KEY_CHANGED'
  | 'AUTH_FAILED'
  | 'PROTOCOL_ERROR'
  | 'REQUEST_TIMEOUT'
  | 'ABORTED'
  | 'CLIENT_CLOSED'
  | 'POOL_TIMEOUT'
  | 'FRAME_TOO_LARGE'
  | 'UNREADABLE_VALUE'
  | 'INVALID_URI'
  | 'INVALID_OPTIONS'
  | 'UNSUPPORTED_FEATURE'
  | 'LEASE_UNKNOWN'
  | 'LEASE_EXPIRED'
  | `UNKNOWN(${number})`;

/** What a refused write did, as far as the server could tell. */
export type WriteOutcome = 'applied' | 'not_applied' | 'unknown';

/** Why AUTH_FAIL was sent (auth.md section 1), reasons 1 to 8. */
export type AuthFailReason =
  | 'CREDENTIALS'
  | 'TOKEN_EXPIRED'
  | 'TOKEN_INVALID'
  | 'TOKEN_UNSUPPORTED'
  | 'PROTOCOL_MISMATCH'
  | 'RATE_LIMITED'
  | 'ALREADY_AUTHED'
  | 'INTERNAL';

/** What the call was doing: the retry table reads the same error differently for each. */
export type CallKind = 'read' | 'write' | 'ddl';

/** The sentinels of one refusal, whatever built it. */
export interface ErrorInit {
  message: string;
  wireCode?: number | null;
  operation: string;
  target?: string;
  requestId?: string;
  retryable?: boolean;
  writeOutcome?: WriteOutcome;
  copiesConfirmed?: number;
  replicationFactor?: number;
  hint?: string;
  cause?: unknown;
}

/** What {@link HoardDBError.toJSON} hands a logger: no cause, so no secret rides along. */
export interface ErrorJSON {
  name: string;
  code: ErrorCode;
  wireCode: number | null;
  message: string;
  operation: string;
  target?: string;
  requestId?: string;
  retryable: boolean;
  writeOutcome?: WriteOutcome;
  copiesConfirmed?: number;
  replicationFactor?: number;
  hint?: string;
  writtenBefore?: number;
}

/** What the caller was doing when the refusal came back. */
export interface ErrorContext {
  operation: string;
  target?: string;
  requestId?: string;
  kind?: CallKind;
  /** The user an AUTH presented, which a credentials refusal names. Never the password. */
  user?: string;
}

/** The fields of an error the driver raises itself, before a class picks it up. */
export type LocalErrorFields = Omit<ErrorInit, 'message'> & {
  kind?: CallKind;
  reason?: AuthFailReason;
  refusal?: FrameRefusal;
};

/** The sentence a write of unknown outcome carries, verbatim wherever it is needed. */
export const unknownOutcomeSentence =
  'The outcome is unknown: read it back before resending, and do not resend a push, a pop or an increment.';

/** The last sentence of a partly written batch's refusal: what to do (insertMany halving, D-20). */
export const PARTIAL_BATCH_SENTENCE = 'Read the batch back before resending, and resend only the documents that are missing.';

/**
 * The server numbers documents within the frame it was sent ("document 2 of the batch", "document 1 of
 * the same batch"): after halving, that is the refused part, not the caller's batch. Only detected, to
 * add one sentence saying so; the server's own words are not rewritten.
 */
const POSITION_IN_BATCH = /\bdocument \d+ of the (same )?batch\b/;

/** The server's "nothing (from the batch) was written": true of the refused part, false of the batch. */
const NOTHING_WRITTEN = /[;,]?\s*(so\s+)?(nothing|none) (from the batch |of it )?was written\.?/i;

/** The same, for a DDL call: it is never a push, a pop or an increment, so it says only what is true. */
export const unknownDdlOutcomeSentence = 'The outcome is unknown: read it back before resending.';

/** The fix for a claim over the hard cap: the code is INVALID_ARGUMENT, so the hint lives with the class. */
const CLAIM_ENTRY_TOO_LARGE_HINT =
  'The entry at the front of the queue is over the size a claim moves. Take it out with pop(), which removes it at most once; claims work again after that.';

const HINTS: Readonly<Partial<Record<ErrorCode, string>>> = {
  LEASE_UNKNOWN:
    'Nothing holds this lease: it was acknowledged, released or returned already, or this bucket never issued it. Its entries are in the queue again or were never under it; claim again with claim().',
  LEASE_EXPIRED:
    'The lease ran out and its entries went back to the queue. Claim again with claim(), and extend a long job with delivery.extend(ms) before the lease ends.',
  NOT_FOUND: 'List what exists with db.listBuckets() or client.listDatabases().',
  ALREADY_EXISTS: 'Pass { ifNotExists: true } to make creation repeatable.',
  DOCUMENT_EXISTS:
    'put, insert and insertMany never replace a document. Use upsert(key, doc) to replace it, or update(key, ops) to change some of its fields.',
  PERMISSION_DENIED: 'This is a role problem: an administrator grants the role named in the message.',
  INTERNAL: 'Report it with the requestId if it repeats.',
  UNSUPPORTED_VERSION: 'This driver speaks hoarddb/1.',
  OVERLOADED:
    "The server's connection cap is full: lower pool.size, or raise HOARDDB_TCP_MAX_CONNS_PER_IP on the server.",
};

function hintFor(code: ErrorCode): string | undefined {
  if (code.startsWith('UNKNOWN(')) return 'A newer server than this driver? Upgrade the driver.';
  return HINTS[code];
}

/**
 * The base of every refusal. `retryable` says a caller may repeat the call, which depends on what
 * the call was doing, so an error whose kind was never recorded is never marked repeatable: a
 * resent write is a duplicate.
 */
export class HoardDBError extends Error {
  readonly [ERROR_BRAND] = true;
  readonly code: ErrorCode;
  readonly wireCode: number | null;
  readonly operation: string;
  readonly target?: string;
  readonly requestId?: string;
  readonly retryable: boolean;
  readonly writeOutcome?: WriteOutcome;
  readonly copiesConfirmed?: number;
  readonly replicationFactor?: number;
  readonly hint?: string;
  /**
   * insertMany only (D-20): how many documents earlier parts of a halved batch wrote before this
   * refusal. They are a prefix of the batch in the order given: the first `writtenBefore` documents.
   * For documents sent without a key, the ids the server assigned to that prefix are not reported.
   */
  readonly writtenBefore?: number;

  constructor(code: ErrorCode, init: ErrorInit) {
    super(init.message, { cause: init.cause });
    Object.setPrototypeOf(this, new.target.prototype);
    this.name = new.target.name;
    this.code = code;
    this.wireCode = init.wireCode ?? null;
    this.operation = init.operation;
    this.target = init.target;
    this.requestId = init.requestId;
    this.retryable = init.retryable ?? false;
    this.writeOutcome = init.writeOutcome;
    this.copiesConfirmed = init.copiesConfirmed;
    this.replicationFactor = init.replicationFactor;
    this.hint = init.hint ?? hintFor(code);
  }

  toJSON(): ErrorJSON {
    const json: ErrorJSON = {
      name: this.name,
      code: this.code,
      wireCode: this.wireCode,
      message: this.message,
      operation: this.operation,
      retryable: this.retryable,
    };
    if (this.target !== undefined) json.target = this.target;
    if (this.requestId !== undefined) json.requestId = this.requestId;
    if (this.writeOutcome !== undefined) json.writeOutcome = this.writeOutcome;
    if (this.copiesConfirmed !== undefined) json.copiesConfirmed = this.copiesConfirmed;
    if (this.replicationFactor !== undefined) json.replicationFactor = this.replicationFactor;
    if (this.hint !== undefined) json.hint = this.hint;
    if (this.writtenBefore !== undefined) json.writtenBefore = this.writtenBefore;
    return json;
  }
}

export class NotFoundError extends HoardDBError {
  constructor(init: ErrorInit) {
    super('NOT_FOUND', init);
  }
}

export class AlreadyExistsError extends HoardDBError {
  constructor(init: ErrorInit) {
    super('ALREADY_EXISTS', init);
  }
}

export class PermissionDeniedError extends HoardDBError {
  constructor(init: ErrorInit) {
    super('PERMISSION_DENIED', init);
  }
}

export class InvalidArgumentError extends HoardDBError {
  readonly constraintRefusal?: boolean;

  constructor(init: ErrorInit & { constraintRefusal?: boolean }) {
    super('INVALID_ARGUMENT', init);
    this.constraintRefusal = init.constraintRefusal;
  }
}

export class InternalError extends HoardDBError {
  /** INTERNAL, except for a wire code this driver does not know, which reads UNKNOWN(n). */
  constructor(init: ErrorInit, code: ErrorCode = 'INTERNAL') {
    super(code, init);
  }
}

export class UnavailableError extends HoardDBError {
  constructor(init: ErrorInit) {
    super('UNAVAILABLE', init);
  }
}

export class WriteConcernTimeoutError extends HoardDBError {
  constructor(init: ErrorInit) {
    super('TIMEOUT', init);
  }
}

export class ConflictError extends HoardDBError {
  constructor(init: ErrorInit) {
    super('CONFLICT', init);
  }
}

export class QuotaExceededError extends HoardDBError {
  constructor(init: ErrorInit) {
    super('QUOTA_EXCEEDED', init);
  }
}

export class UnsupportedVersionError extends HoardDBError {
  constructor(init: ErrorInit) {
    super('UNSUPPORTED_VERSION', init);
  }
}

export class NotAuthenticatedError extends HoardDBError {
  constructor(init: ErrorInit) {
    super('NOT_AUTHENTICATED', init);
  }
}

export class OverloadedError extends HoardDBError {
  constructor(init: ErrorInit) {
    super('OVERLOADED', init);
  }
}

export class ResultTooLargeError extends HoardDBError {
  readonly maxResultBytes?: number;
  readonly retainedBytes?: number;

  constructor(init: ErrorInit & { maxResultBytes?: number; retainedBytes?: number }) {
    super('RESULT_TOO_LARGE', init);
    this.maxResultBytes = init.maxResultBytes;
    this.retainedBytes = init.retainedBytes;
  }
}

export class DuplicateKeyError extends HoardDBError {
  constructor(init: ErrorInit) {
    super('DUPLICATE_KEY', init);
  }
}

export class FieldTypeError extends HoardDBError {
  constructor(init: ErrorInit) {
    super('FIELD_TYPE', init);
  }
}

export class BatchTooLargeError extends HoardDBError {
  constructor(init: ErrorInit) {
    super('BATCH_TOO_LARGE', init);
  }
}

/**
 * A `put`, `insert` or `insertMany` named a key that already holds a document (wire code `0x12`).
 * Nothing was written: `writeOutcome` is `not_applied`. `upsert(key, doc)` replaces the document and
 * `update(key, ops)` changes some of its fields.
 */
export class DocumentExistsError extends HoardDBError {
  constructor(init: ErrorInit) {
    super('DOCUMENT_EXISTS', init);
  }
}

export class ConnectionError extends HoardDBError {
  constructor(init: ErrorInit) {
    super('CONNECTION_FAILED', init);
  }
}

export class TlsTrustError extends HoardDBError {
  constructor(code: 'TLS_UNTRUSTED' | 'TLS_FINGERPRINT_MISMATCH' | 'TLS_KEY_CHANGED', init: ErrorInit) {
    super(code, init);
  }
}

export class AuthenticationError extends HoardDBError {
  readonly reason: AuthFailReason;

  constructor(init: ErrorInit & { reason?: AuthFailReason }) {
    super('AUTH_FAILED', init);
    this.reason = init.reason ?? 'CREDENTIALS';
  }
}

export class ProtocolError extends HoardDBError {
  readonly refusal?: FrameRefusal;

  constructor(init: ErrorInit & { refusal?: FrameRefusal }) {
    super('PROTOCOL_ERROR', init);
    this.refusal = init.refusal;
  }
}

/** What kind of stored value the driver refuses to read, because it cannot be read back unchanged. */
export type UnreadableKind = 'datetime' | 'undefined' | 'dbPointer' | 'unsupported';

/**
 * A stored value the driver will not hand to the program, because handing it over would later alter
 * the data: a datetime outside the range a Date holds, a BSON undefined, a dbPointer. The answer itself
 * decoded and the connection is healthy; only this value is refused. `document` names the document
 * (its key) and `index` its position in a find page; `field` is the path to the value inside that
 * document.
 * When the call was a write, `writeOutcome` is `applied`: the server did what was asked and only the
 * reply could not be read.
 */
export class UnreadableValueError extends HoardDBError {
  readonly valueKind: UnreadableKind;
  readonly field: string;
  readonly document?: string;
  readonly index?: number;

  constructor(init: ErrorInit & { valueKind: UnreadableKind; field: string; document?: string; index?: number }) {
    super('UNREADABLE_VALUE', init);
    this.valueKind = init.valueKind;
    this.field = init.field;
    this.document = init.document;
    this.index = init.index;
  }

  override toJSON(): ErrorJSON & { valueKind: UnreadableKind; field: string; document?: string; index?: number } {
    return {
      ...super.toJSON(),
      valueKind: this.valueKind,
      field: this.field,
      ...(this.document === undefined ? {} : { document: this.document }),
      ...(this.index === undefined ? {} : { index: this.index }),
    };
  }
}

export class RequestTimeoutError extends HoardDBError {
  constructor(init: ErrorInit) {
    super('REQUEST_TIMEOUT', init);
  }
}

export class AbortedError extends HoardDBError {
  constructor(init: ErrorInit) {
    super('ABORTED', init);
  }
}

export class ClientClosedError extends HoardDBError {
  constructor(init: ErrorInit) {
    super('CLIENT_CLOSED', init);
  }
}

export class PoolTimeoutError extends HoardDBError {
  constructor(init: ErrorInit) {
    super('POOL_TIMEOUT', init);
  }
}

export class FrameTooLargeError extends InvalidArgumentError {
  /** The request's payload size in bytes, as the codec computed it; nothing of it was written. */
  readonly encodedBytes?: number;

  constructor(init: ErrorInit & { encodedBytes?: number }) {
    super(init);
    this.encodedBytes = init.encodedBytes;
    // The code is the concrete class's, not the INVALID_ARGUMENT branch it extends.
    Object.defineProperty(this, 'code', { value: 'FRAME_TOO_LARGE', enumerable: true });
  }
}

export class ConfigError extends HoardDBError {
  constructor(code: 'INVALID_URI' | 'INVALID_OPTIONS', init: ErrorInit) {
    super(code, init);
  }
}

export class UnsupportedFeatureError extends HoardDBError {
  constructor(init: ErrorInit) {
    super('UNSUPPORTED_FEATURE', init);
  }
}

/**
 * A lease verb named a lease nothing holds (the in-band `success: false` with `lease_state: unknown`):
 * it was acknowledged, released or returned already, or this bucket never issued it. Nothing was
 * changed. `result` is what the answer carried (the counts and the server's sentence).
 */
export class LeaseUnknownError extends HoardDBError {
  readonly result?: AckResult | ReleaseResult;

  constructor(init: ErrorInit & { result?: AckResult | ReleaseResult }) {
    super('LEASE_UNKNOWN', init);
    this.result = init.result;
  }
}

/**
 * A lease verb named a lease whose time ran out (`lease_state: expired`): its entries went back to the
 * queue. Nothing was acknowledged, released or extended. `result` is what the answer carried.
 */
export class LeaseExpiredError extends HoardDBError {
  readonly result?: AckResult | ReleaseResult;

  constructor(init: ErrorInit & { result?: AckResult | ReleaseResult }) {
    super('LEASE_EXPIRED', init);
    this.result = init.result;
  }
}

/**
 * A claim refused because the entry at the front of the queue is over the hard cap a claim moves
 * (INVALID_ARGUMENT whose sentence starts "claim refused"). It is also an {@link InvalidArgumentError};
 * only a `pop()` unblocks the queue.
 */
export class ClaimEntryTooLargeError extends InvalidArgumentError {
  constructor(init: ErrorInit) {
    super(init);
    // The code stays the wire's INVALID_ARGUMENT (errors.md section 3: the code does not tell this refusal
    // apart); the class is the sentinel, as the Go driver's ErrClaimEntryTooLarge is.
    Object.defineProperty(this, 'hint', { value: init.hint ?? CLAIM_ENTRY_TOO_LARGE_HINT, enumerable: true });
  }
}

/**
 * A requeue or discard the server refused in whole or in part (`success: false`): the entries it did
 * move stay moved. `result` carries the counts and every refusal, so nothing the answer said is lost.
 */
export class DeadMoveRefusedError extends InvalidArgumentError {
  readonly result: DeadMoveResult;

  constructor(init: ErrorInit & { result: DeadMoveResult }) {
    super(init);
    this.result = init.result;
  }
}

type ErrorClass = new (init: ErrorInit) => HoardDBError;

/** Wire code → class, for the classes whose whole code is what the server sent. */
const SERVER_CLASSES: ReadonlyMap<number, ErrorClass> = new Map<number, ErrorClass>([
  [0x00, InternalError],
  [0x01, NotFoundError],
  [0x02, AlreadyExistsError],
  [0x03, PermissionDeniedError],
  [0x05, InternalError],
  [0x06, UnavailableError],
  [0x07, WriteConcernTimeoutError],
  [0x08, ConflictError],
  [0x09, QuotaExceededError],
  [0x0a, UnsupportedVersionError],
  [0x0c, NotAuthenticatedError],
  [0x0d, OverloadedError],
  [0x0f, DuplicateKeyError],
  [0x10, FieldTypeError],
  [0x11, BatchTooLargeError],
  [0x12, DocumentExistsError],
]);

const CODE_BY_WIRE_CODE: ReadonlyMap<number, ErrorCode> = new Map<number, ErrorCode>([
  [0x00, 'INTERNAL'],
  [0x01, 'NOT_FOUND'],
  [0x02, 'ALREADY_EXISTS'],
  [0x03, 'PERMISSION_DENIED'],
  [0x04, 'INVALID_ARGUMENT'],
  [0x05, 'INTERNAL'],
  [0x06, 'UNAVAILABLE'],
  [0x07, 'TIMEOUT'],
  [0x08, 'CONFLICT'],
  [0x09, 'QUOTA_EXCEEDED'],
  [0x0a, 'UNSUPPORTED_VERSION'],
  [0x0b, 'EARLY_DATA_REJECTED'],
  [0x0c, 'NOT_AUTHENTICATED'],
  [0x0d, 'OVERLOADED'],
  [0x0e, 'RESULT_TOO_LARGE'],
  [0x0f, 'DUPLICATE_KEY'],
  [0x10, 'FIELD_TYPE'],
  [0x11, 'BATCH_TOO_LARGE'],
  [0x12, 'DOCUMENT_EXISTS'],
]);

const LOCAL_CLASSES: ReadonlyMap<ErrorCode, ErrorClass> = new Map<ErrorCode, ErrorClass>([
  ['CONNECTION_FAILED', ConnectionError],
  ['AUTH_FAILED', AuthenticationError],
  ['PROTOCOL_ERROR', ProtocolError],
  ['REQUEST_TIMEOUT', RequestTimeoutError],
  ['ABORTED', AbortedError],
  ['CLIENT_CLOSED', ClientClosedError],
  ['POOL_TIMEOUT', PoolTimeoutError],
  ['INVALID_ARGUMENT', InvalidArgumentError],
  ['FRAME_TOO_LARGE', FrameTooLargeError],
  ['UNSUPPORTED_FEATURE', UnsupportedFeatureError],
]);

function codeForWire(wireCode: number): ErrorCode {
  return CODE_BY_WIRE_CODE.get(wireCode) ?? `UNKNOWN(${wireCode})`;
}

function retryableFor(code: ErrorCode, kind: CallKind | undefined, writeOutcome?: WriteOutcome): boolean {
  switch (code) {
    // Sent only when nothing reached the server, so repeating it is safe whatever it was.
    case 'OVERLOADED':
      return true;
    case 'CONNECTION_FAILED':
    case 'NOT_AUTHENTICATED':
      return kind === 'read';
    case 'UNAVAILABLE':
      return kind === 'read' || writeOutcome === 'not_applied';
    default:
      return false;
  }
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function writeOutcomeOf(value: unknown): WriteOutcome | undefined {
  return value === 'applied' || value === 'not_applied' || value === 'unknown' ? value : undefined;
}

/** An AUTH_FAIL payload is optional in the field itself, and older servers send none at all. */
function decodeFields(payload: Uint8Array): Record<string, unknown> {
  return payload.length === 0 ? {} : decodeDocument(payload, 'safe');
}

interface DecodedFields extends ErrorInit {
  constraintRefusal?: boolean;
  maxResultBytes?: number;
  retainedBytes?: number;
}

function buildError(code: ErrorCode, wireCode: number, init: DecodedFields): HoardDBError {
  switch (code) {
    case 'INVALID_ARGUMENT':
      return new InvalidArgumentError(init);
    case 'RESULT_TOO_LARGE':
      return new ResultTooLargeError(init);
    case 'EARLY_DATA_REJECTED':
      return new HoardDBError('EARLY_DATA_REJECTED', init);
    default: {
      const ErrorClass = SERVER_CLASSES.get(wireCode);
      return ErrorClass === undefined ? new InternalError(init, code) : new ErrorClass(init);
    }
  }
}

/** An ERROR frame's payload: the server's sentence byte for byte, the code never guessed. */
export function errorFromErrorPayload(payload: Uint8Array, ctx: ErrorContext): HoardDBError {
  const fields = decodeFields(payload);
  const wireCode = numberOr(fields.code, 0);
  const code = codeForWire(wireCode);
  const writeOutcome = writeOutcomeOf(fields.write_outcome);

  return buildError(code, wireCode, {
    message: typeof fields.message === 'string' ? fields.message : code,
    wireCode,
    operation: ctx.operation,
    target: ctx.target,
    requestId: ctx.requestId,
    retryable: retryableFor(code, ctx.kind, writeOutcome),
    writeOutcome,
    copiesConfirmed: numberOrUndefined(fields.copies_confirmed),
    replicationFactor: numberOrUndefined(fields.replication_factor),
    constraintRefusal: fields.constraint_refusal === true,
    // Only RESULT_TOO_LARGE carries these, and the server leaves a zero out (omitempty in
    // hoardDB/server/proto.go ErrorResponse): nothing retained is retained_bytes absent, so absent is 0.
    maxResultBytes: code === 'RESULT_TOO_LARGE' ? numberOr(fields.max_result_bytes, 0) : undefined,
    retainedBytes: code === 'RESULT_TOO_LARGE' ? numberOr(fields.retained_bytes, 0) : undefined,
  });
}

const AUTH_FAIL_REASONS: readonly AuthFailReason[] = [
  'CREDENTIALS',
  'TOKEN_EXPIRED',
  'TOKEN_INVALID',
  'TOKEN_UNSUPPORTED',
  'PROTOCOL_MISMATCH',
  'RATE_LIMITED',
  'ALREADY_AUTHED',
  'INTERNAL',
];

const AUTH_FAIL_SENTENCES: Readonly<Record<AuthFailReason, string>> = {
  CREDENTIALS:
    'Authentication failed for user "<user>" on <host:port>. Check the user name and password (the root password is HOARDDB_ROOT_PASSWORD, or <data dir>/root.password on the server). The driver does not retry: repeated failures lock this address out.',
  TOKEN_EXPIRED: 'The resumption token was refused on <host:port>; the driver fell back to the password once.',
  TOKEN_INVALID: 'The resumption token was refused on <host:port>; the driver fell back to the password once.',
  TOKEN_UNSUPPORTED: '<host:port> does not accept tokens; the driver uses the password.',
  PROTOCOL_MISMATCH:
    '<host:port> speaks another protocol version than this driver (hoarddb/1). Upgrade the driver or the server.',
  RATE_LIMITED:
    '<host:port> is refusing logins from this address for a while after too many failures; no password was checked. Wait, then try again; the driver stopped retrying.',
  ALREADY_AUTHED: '<host:port> refused a second password on one connection. This is a driver bug; please report it.',
  INTERNAL:
    '<host:port> could not check the login right now (not a credential failure). The driver tried the next host; try again shortly.',
};

/** Zero is not a valid reason, and anything above 8 is from a newer server: both are credentials. */
function authFailReason(value: unknown): AuthFailReason {
  if (typeof value !== 'number') return 'CREDENTIALS';
  return AUTH_FAIL_REASONS[value - 1] ?? 'CREDENTIALS';
}

/** An AUTH_FAIL frame's payload: the driver's sentence, then the server's in quotes if it sent one. */
export function errorFromAuthFail(payload: Uint8Array, ctx: ErrorContext): AuthenticationError {
  const fields = decodeFields(payload);
  const reason = authFailReason(fields.reason);
  const serverMessage = typeof fields.message === 'string' ? fields.message : undefined;
  const where = ctx.target ?? 'the server';
  const driverSentence = AUTH_FAIL_SENTENCES[reason]
    .replaceAll('<host:port>', where)
    .replaceAll('<user>', ctx.user ?? 'the configured user');

  return new AuthenticationError({
    message: serverMessage === undefined ? driverSentence : `${driverSentence} Server said: "${serverMessage}".`,
    operation: ctx.operation,
    target: ctx.target,
    requestId: ctx.requestId,
    reason,
    retryable: reason === 'RATE_LIMITED' || reason === 'INTERNAL',
  });
}

/** A refusal the connection cannot recover from, per the captures: a zero ID, or a frame too big. */
export function isConnectionFatal(error: HoardDBError, requestIdZero: boolean): boolean {
  return requestIdZero || error.message.includes('frame limit');
}

/** The pool's reuse rule, stricter than the server promises. */
export function keepsConnection(error: HoardDBError, requestIdZero: boolean): boolean {
  if (isConnectionFatal(error, requestIdZero)) return false;
  if (error.code === 'INTERNAL' || error.code === 'NOT_AUTHENTICATED') return false;
  return !error.code.startsWith('UNKNOWN(');
}

/** A refusal the driver raises itself, carrying the code and the fields the caller already has. */
export function localError(code: ErrorCode, message: string, fields: LocalErrorFields): HoardDBError {
  const { kind, reason, refusal, ...rest } = fields;
  const init: ErrorInit = {
    ...rest,
    message,
    wireCode: rest.wireCode ?? null,
    retryable: rest.retryable ?? retryableFor(code, kind, rest.writeOutcome),
  };

  switch (code) {
    case 'TLS_UNTRUSTED':
    case 'TLS_FINGERPRINT_MISMATCH':
    case 'TLS_KEY_CHANGED':
      return new TlsTrustError(code, init);
    case 'INVALID_URI':
    case 'INVALID_OPTIONS':
      return new ConfigError(code, init);
    case 'AUTH_FAILED':
      return new AuthenticationError(reason === undefined ? init : { ...init, reason });
    case 'PROTOCOL_ERROR':
      return new ProtocolError(refusal === undefined ? init : { ...init, refusal });
    case 'INVALID_ARGUMENT':
      return new InvalidArgumentError(init);
    case 'FRAME_TOO_LARGE':
      return new FrameTooLargeError(init);
    default: {
      const ErrorClass = LOCAL_CLASSES.get(code);
      return ErrorClass === undefined ? new HoardDBError(code, init) : new ErrorClass(init);
    }
  }
}

/**
 * A refusal of a later part of a halved batch, after earlier parts were written (D-20): it carries how
 * many documents were written before it (a prefix of the batch, in order), its outcome becomes unknown
 * because the batch as a whole is partly written (left not_applied, it would invite resending the whole
 * batch, and the written part twice), and its message says, in order, what the server refused and why,
 * what was written, and what to do. A refusal from a nested half that already counts some keeps them
 * in the sum.
 */
export function partialBatch(error: unknown, writtenEarlier: number): unknown {
  if (!isHoardDBError(error) || writtenEarlier === 0) return error;
  // The server's reason, once: its "nothing from the batch was written" is true of the refused part
  // only, and the unknown-outcome sentence call() may have added is replaced by the batch's account.
  let reason = partialReasons.get(error);
  if (reason === undefined) {
    reason = error.message.replace(unknownOutcomeSentence, '').replace(NOTHING_WRITTEN, '').trim().replace(/\.$/, '');
    partialReasons.set(error, reason);
  }
  const written = writtenEarlier + (error.writtenBefore ?? 0);
  Object.defineProperty(error, 'writtenBefore', { value: written, enumerable: true });
  Object.defineProperty(error, 'writeOutcome', { value: 'unknown', enumerable: true });
  Object.defineProperty(error, 'retryable', { value: false, enumerable: true });
  const numbering = POSITION_IN_BATCH.test(reason)
    ? `The server's document numbers count within the refused part, which begins at document ${written + 1} of this batch. `
    : '';
  error.message =
    `The server refused a later part of this batch, after its first ${written} documents: ${reason}. ${numbering}` +
    `The first ${written} documents of the batch, in the order given, were written. ${PARTIAL_BATCH_SENTENCE}`;
  return error;
}

/** The server's own reason for each partly written batch's refusal, kept across nested halving. */
const partialReasons = new WeakMap<object, string>();

/** Identity that survives the dual build, and a hand-built refusal that carries the brand. */
export function isHoardDBError(value: unknown): value is HoardDBError {
  if (value instanceof HoardDBError) return true;
  if (typeof value !== 'object' || value === null) return false;
  const branded = value as { [ERROR_BRAND]?: unknown; code?: unknown };
  return branded[ERROR_BRAND] === true && typeof branded.code === 'string';
}
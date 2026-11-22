// SPDX-License-Identifier: Apache-2.0
//
// One call: encode it, take a slot, send it, and say what the answer meant (build doc step 10;
// handbook wire.md sections 4 and 6). Three orders live here rather than in the verbs above it,
// because a caller that gets any of them wrong loses data rather than an assertion: a write is
// never resent once it has gone out, a frame that does not fit is refused before a byte is
// written, and a refusal that finishes the socket costs one dial rather than one per attempt.
//
// The two option types below are the shape section 3.3 gives them; step 11 declares them with the
// rest of the public surface in src/types.ts, and this module keeps its own so that it does not
// depend on a file that does not exist yet.

import { inheritDetails, refusalDetails, unreadableMessage, type Int64Mode } from './codec/index.js';
import {
  AbortedError,
  ClientClosedError,
  FrameTooLargeError,
  InternalError,
  InvalidArgumentError,
  ProtocolError,
  RequestTimeoutError,
  UnreadableValueError,
  UnsupportedFeatureError,
  errorFromErrorPayload,
  isHoardDBError,
  keepsConnection,
  type ErrorCode,
  unknownDdlOutcomeSentence,
  unknownOutcomeSentence,
  type HoardDBError,
} from './errors.js';
import type { Lane, Pool } from './pool.js';
import { decideRetry, retryableFor, type CallKind, type RetryDecision } from './retry.js';
import { MAX_LENGTH, MIN_LENGTH, isZeroRequestId, requestIdHex, type Frame } from './wire/frame.js';
import { decodeResponse, encodeRequest } from './wire/messages.js';
import { Op, SUCCESS_REPLY, type OpName } from './wire/opcodes.js';

/** What every verb takes: the deadline and the cancellation, and nothing else. */
export interface OpOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

/** The three words the server's write concern takes, and the only three (section 3.3). */
export type WriteConcern = 'one' | 'majority' | 'all';

export interface CallSpec {
  /** The caller's name for the verb ('put', 'find', 'createBucket'), which every error carries. */
  operation: string;
  /** What the call was about, in the driver's spelling: 'app/users/ada', 'app', 'host:port'. */
  target: string;
  op: OpName;
  fields: Record<string, unknown>;
  lane: Lane;
  kind: CallKind;
  opts?: OpOptions & { writeConcern?: WriteConcern };
  /**
   * Codes the verb swallows on purpose (createDatabase with ifNotExists swallows ALREADY_EXISTS): the
   * call does not count them, and the verb's own counter counts one only if it reaches the caller.
   */
  uncounted?: readonly ErrorCode[];
}

/** Refusals already counted, so one that crosses several layers is counted once (poolStats().errors). */
const counted = new WeakSet<object>();

/**
 * Counts a refusal in the client's statistics, once, whoever raised it and however many layers it
 * passes through on its way to the caller. Anything that is not one of the driver's refusals (a bug)
 * is not a refusal the program can match on, and is not counted.
 */
export function countRefusal(stats: CallStats, error: unknown): void {
  if (!isHoardDBError(error) || counted.has(error)) return;
  counted.add(error);
  stats.errors[error.code] = (stats.errors[error.code] ?? 0) + 1;
}

export interface CallStats {
  requests: number;
  retries: number;
  errors: Record<string, number>;
}

export interface CallContext {
  pool: Pool;
  requestTimeoutMs: number;
  int64: Int64Mode;
  random: () => number;
  now: () => number;
  capabilities: () => ReadonlySet<string>;
  serverVersion: () => string;
  stats: CallStats;
  closed: () => boolean;
}

/** Wait out a backoff, or stop the moment the caller aborts: true when the wait was cut short. */
function waitUnlessAborted(ms: number, signal: AbortSignal | undefined): Promise<boolean> {
  if (signal?.aborted === true) return Promise.resolve(true);
  return new Promise((resolveWait) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      resolveWait(true);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolveWait(false);
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** The caller stopped the call before anything of it was written (section 5.2's template). */
function abortedCall(spec: CallSpec, signal: AbortSignal | undefined): AbortedError {
  return new AbortedError({
    message: `${spec.operation} on ${spec.target} was aborted.`,
    operation: spec.operation,
    target: spec.target,
    writeOutcome: 'not_applied',
    cause: signal?.reason,
  });
}

const FAIL: RetryDecision = { action: 'fail' };

/**
 * Node's timers and Date.now() can disagree by a millisecond: a dial bounded to the last millisecond
 * can time out while the clock still reads just before the deadline. Within this much of it, a dial
 * or a login that timed out was cut short by the deadline.
 */
const DEADLINE_SLACK_MS = 2;

/** Section 5.2's PROTOCOL_ERROR sentence for a success answer the driver could not read. */
function undecodable(spec: CallSpec, address: string, error: unknown): ProtocolError {
  return new ProtocolError({
    message: `The server at ${address} sent a ${spec.op} answer that does not decode (${(error as Error).message}). The connection was discarded.`,
    operation: spec.operation,
    target: spec.target,
    cause: error,
  });
}

/**
 * The refusal of a value in an answer, with the call's own name. The document of a get or an update
 * is the key the program asked for when the reply does not carry it. A write was applied: the server
 * answered it, only the reply could not be read, and saying "unknown" would invite a second send.
 */
function unreadable(spec: CallSpec, refusal: UnreadableValueError, requestId: string): UnreadableValueError {
  const asked = spec.fields['key'];
  const document = refusal.document ?? (refusal.index === undefined && typeof asked === 'string' ? asked : undefined);
  const applied = spec.kind === 'write';
  const message = unreadableMessage(refusal.valueKind, refusal.field, {
    ...(document === undefined ? {} : { document }),
    ...(refusal.index === undefined ? {} : { index: refusal.index }),
    ...(refusalDetails(refusal)?.wireType === undefined ? {} : { wireType: refusalDetails(refusal)?.wireType }),
  });
  const error = new UnreadableValueError({
    message: applied
      ? `${message} The ${spec.operation} was applied on the server and only its reply could not be read, so do not send it again.`
      : message,
    operation: spec.operation,
    target: spec.target,
    requestId,
    valueKind: refusal.valueKind,
    field: refusal.field,
    ...(document === undefined ? {} : { document }),
    ...(refusal.index === undefined ? {} : { index: refusal.index }),
    ...(applied ? { writeOutcome: 'applied' as const } : {}),
  });
  inheritDetails(refusal, error);
  return error;
}

/** Section 5.2's FRAME_TOO_LARGE sentence, with the payload's real byte count. */
function frameTooLarge(spec: CallSpec, payloadBytes: number): FrameTooLargeError {
  return new FrameTooLargeError({
    message: `This ${spec.operation} encodes to ${payloadBytes} bytes; a frame holds at most ${MAX_LENGTH} (1 + 16 + payload ≤ 32 MiB). Nothing was sent. Split it into smaller batches, or store a large value as a blob.`,
    operation: spec.operation,
    target: spec.target,
    encodedBytes: payloadBytes,
  });
}

/** The call's deadline passed before anything was written: safe to repeat, and it says so. */
function startedTooLate(spec: CallSpec, timeoutMs: number, cause?: HoardDBError): RequestTimeoutError {
  return new RequestTimeoutError({
    message: `${spec.operation} on ${spec.target} timed out after ${timeoutMs} ms before it was sent (no connection was ready in time). Nothing was sent, so it is safe to repeat. For a slow call raise { timeoutMs }.`,
    operation: spec.operation,
    target: spec.target,
    writeOutcome: 'not_applied',
    cause,
  });
}

/**
 * A refusal the connection raised during the send names the connection's opcode and address; the
 * caller called it "insert on app/users". The abort and the timeout get section 5.2's sentence with
 * the call's names, keeping whatever outcome the connection established; the rest keep their
 * sentence (it names the server) and take the call's operation and target.
 */
function sendFailure(spec: CallSpec, timeoutMs: number, error: HoardDBError, signal: AbortSignal | undefined): HoardDBError {
  const outcome = error.writeOutcome === undefined ? {} : { writeOutcome: error.writeOutcome };
  if (error.code === 'ABORTED') {
    return new AbortedError({
      message: `${spec.operation} on ${spec.target} was aborted.`,
      operation: spec.operation,
      target: spec.target,
      ...outcome,
      cause: signal?.reason ?? error,
    });
  }
  if (error.code === 'REQUEST_TIMEOUT') {
    return new RequestTimeoutError({
      message: `${spec.operation} on ${spec.target} timed out after ${timeoutMs} ms. For a slow call raise { timeoutMs }; the connection was discarded.`,
      operation: spec.operation,
      target: spec.target,
      ...outcome,
      cause: error,
    });
  }
  if (error.code === 'CONNECTION_FAILED') {
    // 'failed during connect (…)' is the connection's view; section 5.2 says during which call.
    const reason = / \(([^()]*)\)\.$/.exec(error.message)?.[1];
    if (reason !== undefined) {
      error.message = `The connection to ${address(error)} failed during ${spec.operation} (${reason}).`;
    }
  }
  return onCall(error, spec);
}

/** The host:port a connection refusal was about, before onCall replaces its target with the call's. */
function address(error: HoardDBError): string {
  return error.target ?? 'the server';
}

/** A refusal that came before anything was written: not_applied, unless the server said otherwise. */
function notSent(error: HoardDBError): HoardDBError {
  if (error.writeOutcome === undefined) {
    Object.defineProperty(error, 'writeOutcome', { value: 'not_applied', enumerable: true });
  }
  return error;
}

/**
 * A refusal raised below the call (the connection's own operation and address, or none) carries the
 * call's operation and target instead, so a caller can tell which of its calls it was.
 */
function onCall(error: HoardDBError, spec: CallSpec): HoardDBError {
  Object.defineProperty(error, 'operation', { value: spec.operation, enumerable: true });
  Object.defineProperty(error, 'target', { value: spec.target, enumerable: true });
  return error;
}

/** Anything thrown that is not one of the driver's own refusals becomes one. */
function refusalOf(error: unknown, spec: CallSpec): HoardDBError {
  if (isHoardDBError(error)) return error;
  return new InternalError({
    message: `${spec.operation} failed: ${(error as Error).message}`,
    operation: spec.operation,
    target: spec.target,
    cause: error,
  });
}

/**
 * How far a call got before it failed, which decides what the caller is told about its outcome:
 * nothing was written; it was written and no answer came back (lost, timed out, unreadable); or the
 * server answered it with a refusal.
 */
type Reach = 'not-sent' | 'sent' | 'answered' | 'answered-request';

/** The pops: each removes what it returns, so a lost answer may have taken entries. */
const POP_OPS: ReadonlySet<OpName> = new Set<OpName>(['FIFO_POP', 'LIFO_POP', 'HEAP_POP', 'FIELD_POP']);

/** How many entries a pop may have removed: its `limit`, 1 when the request left it off. */
function popMayHaveRemoved(spec: CallSpec): number | undefined {
  if (!POP_OPS.has(spec.op)) return undefined;
  const limit = Number(spec.fields['limit'] ?? 0);
  return limit > 0 ? limit : 1;
}

/**
 * What the caller is handed. A write refused before it was sent is not_applied. An outcome is unknown only when the request went out and no answer came
 * back: a write is then told to read back and not to resend a push, a pop or an increment, a DDL call
 * only to read back. A server refusal says what happened. For a DDL call no outcome is normal and
 * nothing changed; for a write handbook errors.md section 4 says an absent write_outcome is treated as
 * unknown, so a write refused without one keeps the write sentence. `retryable` is stamped by what the
 * call was doing. Counted once per refusal that leaves here, so poolStats() counts calls the program
 * saw, not attempts made behind them.
 */
function surfaced(ctx: CallContext, spec: CallSpec, error: HoardDBError, how: Reach): HoardDBError {
  // A write refused before a byte of it was written did not happen (section 5.2), whoever refused it.
  if (how === 'not-sent' && spec.kind === 'write' && error.writeOutcome === undefined) {
    Object.defineProperty(error, 'writeOutcome', { value: 'not_applied', enumerable: true });
  }
  const unknown =
    error.writeOutcome === undefined &&
    ((how === 'sent' && spec.kind !== 'read') ||
      (how === 'answered' && spec.kind === 'write') ||
      // An OVERLOADED that answers a request by its ID may have been applied, for DDL as for data.
      (how === 'answered-request' && spec.kind !== 'read'));
  if (unknown) {
    Object.defineProperty(error, 'writeOutcome', { value: 'unknown', enumerable: true });
    const removed = popMayHaveRemoved(spec);
    const sentence =
      spec.kind === 'ddl'
        ? unknownDdlOutcomeSentence
        : removed === undefined
          ? unknownOutcomeSentence
          : `outcome unknown: the pop may have removed up to ${String(removed)} entries; run peek to see what is left.`;
    if (!error.message.includes(sentence)) {
      error.message = `${error.message} ${sentence}`;
    }
  } else if (error.code === 'TIMEOUT' && error.writeOutcome === 'applied' && popMayHaveRemoved(spec) !== undefined) {
    // A pop the owner applied is answered with its entries; a TIMEOUT here carried none of them.
    const sentence = `the pop was applied or refused and its answer carried no entries: it may have removed up to ${String(popMayHaveRemoved(spec))} entries; run peek to see what is left.`;
    if (!error.message.includes(sentence)) error.message = `${error.message} ${sentence}`;
  }

  const retryable = retryableFor(error, spec.kind);
  if (retryable !== error.retryable) {
    Object.defineProperty(error, 'retryable', { value: retryable, enumerable: true });
  }

  if (spec.uncounted?.includes(error.code) !== true) countRefusal(ctx.stats, error);
  return error;
}

/**
 * One request and its answer, with the retries the table allows and none it does not. The decoded
 * success payload is what the verb reads; every refusal is thrown and counted.
 */
export async function call(ctx: CallContext, spec: CallSpec): Promise<Record<string, unknown>> {
  if (ctx.closed()) {
    throw surfaced(
      ctx,
      spec,
      new ClientClosedError({
        message: 'This client was closed. Create a new one with connect().',
        operation: spec.operation,
        target: spec.target,
      }),
      'not-sent',
    );
  }

  const signal = spec.opts?.signal;
  if (signal?.aborted === true) throw surfaced(ctx, spec, abortedCall(spec, signal), 'not-sent');

  let payload: Uint8Array;
  try {
    // A concern the server does not advertise is refused here, so the verb never learns about it.
    const concern = validateWriteConcern(spec.opts?.writeConcern, ctx, spec.operation);
    payload = encodeRequest(spec.op, concern === undefined ? spec.fields : { ...spec.fields, writeconcern: concern });
  } catch (error) {
    // Too large to write at all: refused from the size the codec computed, never serialized. Every
    // other refusal here is counted and names the call like one from the server would.
    const refusal =
      error instanceof FrameTooLargeError && error.encodedBytes !== undefined
        ? frameTooLarge(spec, error.encodedBytes)
        : onCall(refusalOf(error, spec), spec);
    throw surfaced(ctx, spec, refusal, 'not-sent');
  }
  if (MIN_LENGTH + payload.length > MAX_LENGTH) {
    throw surfaced(ctx, spec, frameTooLarge(spec, payload.length), 'not-sent');
  }

  const timeoutMs = spec.opts?.timeoutMs ?? ctx.requestTimeoutMs;
  const deadline = ctx.now() + timeoutMs;
  let attempts = 0;
  let refusedDials = 0;
  /** The server refusal a retry is waiting out: what the caller hears if the deadline ends the wait. */
  let waitingOut: HoardDBError | undefined;

  for (;;) {
    let lease;
    try {
      lease = await ctx.pool.acquire(spec.lane, deadline, signal);
    } catch (error) {
      // Nothing was written, so the table reads it as a dial: OVERLOADED waits and dials again for
      // every kind of call (a write is safe to repeat: it never left this process). A connection
      // failure is final here, because the pool has already tried every host once.
      const refusal = refusalOf(error, spec);
      // The pool's abort names the pool; the caller aborted this call, and nothing of it was sent.
      const failure = refusal.code === 'ABORTED' ? abortedCall(spec, signal) : refusal;
      // A dial or a login cut short by the caller's own deadline is the call timing out, not the
      // server being down: say so, and that nothing was written.
      if (
        (failure.code === 'CONNECTION_FAILED' || failure.code === 'REQUEST_TIMEOUT') &&
        deadline - ctx.now() < DEADLINE_SLACK_MS
      ) {
        // Giving up on a busy server says what the server said (handbook errors.md section 5).
        const final = waitingOut === undefined ? startedTooLate(spec, timeoutMs, failure) : notSent(onCall(waitingOut, spec));
        throw surfaced(ctx, spec, final, 'not-sent');
      }
      refusedDials += 1;
      const decision =
        failure.code === 'CONNECTION_FAILED'
          ? FAIL
          : decideRetry({
              error: failure,
              kind: spec.kind,
              attempts: refusedDials,
              responseStarted: false,
              remainingMs: deadline - ctx.now(),
              random: ctx.random,
            });
      // Nothing of the call was written, whatever the pool says, and the caller is told so.
      if (decision.action === 'fail') throw surfaced(ctx, spec, notSent(onCall(failure, spec)), 'not-sent');
      waitingOut = failure;
      if (decision.action === 'retry-after' && (await waitUnlessAborted(decision.delayMs, signal))) {
        throw surfaced(ctx, spec, abortedCall(spec, signal), 'not-sent');
      }
      ctx.stats.retries += 1;
      continue;
    }

    // A slot that arrives after the deadline is given back unused: a write sent now could only be
    // reported unknown, and a read could only time out.
    if (deadline - ctx.now() <= 0) {
      lease.release();
      throw surfaced(ctx, spec, startedTooLate(spec, timeoutMs), 'not-sent');
    }

    attempts += 1;
    ctx.stats.requests += 1;
    let frame: Frame;
    try {
      frame = await lease.connection.send(Op[spec.op], payload, {
        timeoutMs: Math.max(deadline - ctx.now(), 0),
        signal,
        expect: SUCCESS_REPLY[spec.op] ?? [Op[spec.op]],
      });
    } catch (error) {
      // The socket is spent whatever the refusal was: a timed-out or aborted connection was already
      // destroyed by send(), and a refusal over it never could be read again.
      lease.discard();
      const failure = sendFailure(spec, timeoutMs, refusalOf(error, spec), signal);
      if (
        decideRetry({
          error: failure,
          kind: spec.kind,
          attempts,
          responseStarted: false,
          remainingMs: deadline - ctx.now(),
          random: ctx.random,
        }).action === 'fail'
      ) {
        throw surfaced(ctx, spec, failure, 'sent');
      }
      ctx.stats.retries += 1;
      continue;
    }

    if (frame.opcode !== Op.ERROR) {
      let answer: Record<string, unknown>;
      try {
        answer = decodeResponse(spec.op, frame.payload, ctx.int64);
      } catch (error) {
        // A value the driver refuses to read is not a broken stream: the answer decoded, the server
        // did what was asked, and the connection is as good as before.
        if (error instanceof UnreadableValueError) {
          lease.release();
          throw surfaced(ctx, spec, unreadable(spec, error, requestIdHex(frame.requestId)), 'answered');
        }
        // An answer that does not decode says the stream is not what it should be: the socket goes.
        lease.discard();
        throw surfaced(ctx, spec, undecodable(spec, lease.connection.address, error), 'sent');
      }
      lease.release();
      return answer;
    }

    const failure = errorFromErrorPayload(frame.payload, {
      operation: spec.operation,
      target: spec.target,
      requestId: requestIdHex(frame.requestId),
      kind: spec.kind,
    });
    const answersRequest = !isZeroRequestId(frame.requestId);
    if (keepsConnection(failure, !answersRequest)) lease.release();
    else lease.discard();

    const decision = decideRetry({
      error: failure,
      kind: spec.kind,
      attempts,
      responseStarted: true,
      answersRequest,
      remainingMs: deadline - ctx.now(),
      random: ctx.random,
    });
    if (decision.action === 'fail') {
      const overloadedRequest = failure.code === 'OVERLOADED' && answersRequest;
      throw surfaced(ctx, spec, failure, overloadedRequest ? 'answered-request' : 'answered');
    }
    // Only a refusal the table retries gets here, which is one that wrote nothing (or a read), so an
    // abort during the wait is a call that never happened.
    if (decision.action === 'retry-after' && (await waitUnlessAborted(decision.delayMs, signal))) {
      throw surfaced(ctx, spec, abortedCall(spec, signal), 'not-sent');
    }
    ctx.stats.retries += 1;
  }
}

/**
 * The write concern a call may carry, or a refusal that names the fix. A server without the
 * capability is told before anything is sent, because the answer would otherwise be a silent
 * default rather than the durability the caller asked for.
 */
export function validateWriteConcern(value: unknown, ctx: CallContext, operation: string): string | undefined {
  if (value === undefined) return undefined;

  if (value !== 'one' && value !== 'majority' && value !== 'all') {
    throw new InvalidArgumentError({
      message: `writeConcern "${String(value)}" is not one of one, majority, all.`,
      operation,
    });
  }

  if (!ctx.capabilities().has('write_concern')) {
    throw new UnsupportedFeatureError({
      message: `This server (${ctx.serverVersion()}) does not advertise "write_concern", so { writeConcern: '${value}' } cannot be honoured. Nothing was sent. Upgrade the server, or leave the option out.`,
      operation,
    });
  }

  return value;
}
// SPDX-License-Identifier: Apache-2.0
//
// The request layer against the in-process fake server. What this layer has to get right never
// shows up in a successful answer: a write is not resent once it has gone out, a read is retried
// once on a new connection, a refusal that finishes the socket costs the caller one socket and no
// more, and a frame too big for the wire is refused before a byte is written (build doc section 5.4;
// handbook errors.md section 6).

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { Session } from '../../src/auth.js';
import { call, validateWriteConcern, type CallContext, type CallSpec, type CallStats } from '../../src/call.js';
import {
  AuthenticationError,
  ConnectionError,
  FrameTooLargeError,
  HoardDBError,
  InternalError,
  InvalidArgumentError,
  NotFoundError,
  OverloadedError,
  ProtocolError,
  UnreadableValueError,
  UnsupportedFeatureError,
  WriteConcernTimeoutError,
  unknownDdlOutcomeSentence,
  unknownOutcomeSentence,
} from '../../src/errors.js';
import { Pool, type PoolConfig } from '../../src/pool.js';
import { decideRetry, retryableFor, type CallKind, type RetryDecision } from '../../src/retry.js';
import { makeTrustPolicy } from '../../src/trust.js';
import { MAX_LENGTH } from '../../src/wire/frame.js';
import type { Frame } from '../../src/wire/frame.js';
import { Op } from '../../src/wire/opcodes.js';
import { authOkDoc, startFakeServer, type FakeConnection, type FakeServer } from '../helpers/fake-server.js';
import { document, element, outOfRangeDate, stringElement } from '../helpers/raw-bson.js';
import { makeTlsIdentity, removeTlsIdentity, type TlsIdentity } from '../helpers/tls-identity.js';

const PASSWORD = 'pw-SECRET-1';
/** The pool's defaults (D-25); a test that varies nothing else must not name them all again. */
const BASE_CONFIG: PoolConfig = {
  size: 4,
  bulkSize: 2,
  maxWaiters: 100,
  idleTimeoutMs: 120_000,
  pingIntervalMs: 60_000,
  heartbeatMs: 5_000,
};
const AUTH_CAPABILITIES = ['pipelining', 'get_fast', 'write_concern', 'consistent_get', 'auth_token'];

let identity: TlsIdentity;
const servers: FakeServer[] = [];
const pools: Pool[] = [];

before(() => {
  identity = makeTlsIdentity();
});

after(async () => {
  for (const pool of pools) await pool.close(0);
  for (const server of servers) await server.close();
  removeTlsIdentity(identity);
});

/** The helper's AUTH_OK (token stamps in Unix seconds, as the server sends them) with these capabilities. */
function authOk(capabilities: string[]): Record<string, unknown> {
  return authOkDoc({ capabilities });
}

/** How many frames of an opcode the fake has been given, which is what the retry rules are about. */
const framesByOpcode = new Map<number, number>();

function countOf(opcode: number): number {
  return framesByOpcode.get(opcode) ?? 0;
}

interface Harness {
  server: FakeServer;
  pool: Pool;
  ctx: CallContext;
  stats: CallStats;
  run(spec: Partial<CallSpec>): Promise<Record<string, unknown>>;
}

/**
 * A pool, a context and a fake server in one call. The fake counts every frame it is given, answers
 * a login and a liveness probe, and hands everything else to the test.
 */
async function harness(
  answer: (frame: Frame, conn: FakeConnection, seen: number) => void = () => undefined,
  capabilities: string[] = AUTH_CAPABILITIES,
  onConnect?: (conn: FakeConnection) => void,
  authDelayMs = 0,
): Promise<Harness> {
  framesByOpcode.clear();
  let version = 'fake';

  const server = await startFakeServer({
    identity,
    ...(onConnect === undefined ? {} : { onConnect }),
    onFrame: (frame, conn) => {
      framesByOpcode.set(frame.opcode, countOf(frame.opcode) + 1);
      const seen = countOf(frame.opcode);
      if (frame.opcode === Op.AUTH) {
        if (authDelayMs === 0) conn.replyDoc(Op.AUTH_OK, frame.requestId, authOk(capabilities));
        else setTimeout(() => conn.replyDoc(Op.AUTH_OK, frame.requestId, authOk(capabilities)), authDelayMs);
        return;
      }
      if (frame.opcode === Op.PING) {
        conn.reply(Op.PONG, frame.requestId, new Uint8Array(0));
        return;
      }
      answer(frame, conn, seen);
    },
  });
  servers.push(server);

  const pool = new Pool({
    hosts: [{ host: '127.0.0.1', port: server.port, hostIndex: 0 }],
    trust: makeTrustPolicy({ fingerprints: [identity.fingerprint], knownServersPath: false }, [], 1),
    dialTimeoutMs: 5_000,
    session: new Session({ username: 'admin', password: PASSWORD }, Date.now),
    clientName: 'call-test',
    config: BASE_CONFIG,
    now: Date.now,
    random: () => 0,
    onAuth: (result) => {
      version = result.serverVersion;
    },
  });
  pools.push(pool);

  const stats: CallStats = { requests: 0, retries: 0, errors: {} };
  const ctx: CallContext = {
    pool,
    requestTimeoutMs: 5_000,
    int64: 'safe',
    random: () => 0,
    now: Date.now,
    capabilities: () => new Set(capabilities),
    serverVersion: () => version,
    stats,
    closed: () => false,
  };

  return {
    server,
    pool,
    ctx,
    stats,
    run: (spec) => call(ctx, { ...readSpec, ...spec }),
  };
}

const readSpec: CallSpec = {
  operation: 'get',
  target: 'app/users/ada',
  op: 'GET',
  lane: 'point',
  kind: 'read',
  fields: { database: 'app', bucket: 'users', key: 'ada' },
};

const writeSpec: CallSpec = {
  operation: 'put',
  target: 'app/users/ada',
  op: 'PUT',
  lane: 'point',
  kind: 'write',
  fields: { database: 'app', bucket: 'users', key: 'ada', data: { Name: 'Ada' } },
};

function answerDoc(opcode: number, doc: Record<string, unknown>) {
  return (frame: Frame, conn: FakeConnection): void => conn.replyDoc(opcode, frame.requestId, doc);
}

/** An ERROR frame the way the server sends one: the wire code, its sentence, nothing invented. */
function answerError(frame: Frame, conn: FakeConnection, doc: Record<string, unknown>): void {
  conn.replyDoc(Op.ERROR, frame.requestId, doc);
}

const sleep = (ms: number): Promise<void> => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));

async function waitFor(what: string, reached: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!reached()) {
    if (Date.now() > deadline) throw new Error(`gave up waiting for ${what}`);
    await sleep(5);
  }
}

test('decideRetry follows the table', () => {
  const refused = (code: HoardDBError['code'], extra: Partial<HoardDBError> = {}): HoardDBError =>
    new HoardDBError(code, { message: 'refused by the test', operation: 'get', target: 'app/users/ada', ...extra });

  const fail: RetryDecision = { action: 'fail' };
  const now = (): RetryDecision => ({ action: 'retry-now' });
  const after50: RetryDecision = { action: 'retry-after', delayMs: 50 };

  interface Row {
    name: string;
    error: HoardDBError;
    attempts?: number;
    responseStarted?: boolean;
    remainingMs?: number;
    random?: number;
    expected: Record<CallKind, RetryDecision>;
    retryable: Record<CallKind, boolean>;
  }

  const rows: Row[] = [
    {
      name: 'a connection lost before any response byte',
      error: refused('CONNECTION_FAILED'),
      attempts: 1,
      responseStarted: false,
      remainingMs: 1_000,
      random: 0.5,
      expected: { read: now(), write: fail, ddl: fail },
      retryable: { read: true, write: false, ddl: false },
    },
    {
      name: 'a connection lost on the second attempt',
      error: refused('CONNECTION_FAILED'),
      attempts: 2,
      responseStarted: false,
      remainingMs: 1_000,
      random: 0.5,
      expected: { read: fail, write: fail, ddl: fail },
      retryable: { read: true, write: false, ddl: false },
    },
    {
      name: 'a connection lost after a response byte',
      error: refused('CONNECTION_FAILED'),
      attempts: 1,
      responseStarted: true,
      remainingMs: 1_000,
      random: 0.5,
      expected: { read: fail, write: fail, ddl: fail },
      retryable: { read: true, write: false, ddl: false },
    },
    {
      name: 'UNAVAILABLE with no outcome on a write',
      error: refused('UNAVAILABLE'),
      attempts: 1,
      responseStarted: true,
      remainingMs: 10_000,
      random: 0.5,
      expected: { read: after50, write: fail, ddl: fail },
      retryable: { read: true, write: false, ddl: false },
    },
    {
      name: 'UNAVAILABLE with not_applied',
      error: refused('UNAVAILABLE', { writeOutcome: 'not_applied' }),
      attempts: 1,
      responseStarted: true,
      remainingMs: 10_000,
      random: 0.5,
      expected: { read: after50, write: after50, ddl: after50 },
      retryable: { read: true, write: true, ddl: true },
    },
    {
      name: 'UNAVAILABLE with applied',
      error: refused('UNAVAILABLE', { writeOutcome: 'applied' }),
      attempts: 1,
      responseStarted: true,
      remainingMs: 10_000,
      random: 0.5,
      expected: { read: after50, write: fail, ddl: fail },
      retryable: { read: true, write: false, ddl: false },
    },
    {
      name: 'UNAVAILABLE on the third attempt backs off further',
      error: refused('UNAVAILABLE'),
      attempts: 3,
      responseStarted: true,
      remainingMs: 10_000,
      random: 0.5,
      expected: { read: { action: 'retry-after', delayMs: 200 }, write: fail, ddl: fail },
      retryable: { read: true, write: false, ddl: false },
    },
    {
      name: 'a backoff that would pass the deadline',
      error: refused('UNAVAILABLE'),
      attempts: 1,
      responseStarted: true,
      remainingMs: 100,
      random: 1,
      expected: { read: fail, write: fail, ddl: fail },
      retryable: { read: true, write: false, ddl: false },
    },
    {
      name: 'OVERLOADED on a dial',
      error: refused('OVERLOADED'),
      attempts: 1,
      responseStarted: false,
      remainingMs: 10_000,
      random: 0.25,
      expected: {
        read: { action: 'retry-after', delayMs: 25 },
        write: { action: 'retry-after', delayMs: 25 },
        ddl: { action: 'retry-after', delayMs: 25 },
      },
      retryable: { read: true, write: true, ddl: true },
    },
    {
      name: 'NOT_AUTHENTICATED',
      error: refused('NOT_AUTHENTICATED'),
      attempts: 1,
      responseStarted: true,
      remainingMs: 1_000,
      random: 0.5,
      expected: { read: now(), write: fail, ddl: fail },
      retryable: { read: true, write: false, ddl: false },
    },
    {
      name: 'TIMEOUT (write concern)',
      error: refused('TIMEOUT'),
      attempts: 1,
      responseStarted: true,
      remainingMs: 10_000,
      random: 0.5,
      expected: { read: fail, write: fail, ddl: fail },
      retryable: { read: false, write: false, ddl: false },
    },
    {
      name: 'RESULT_TOO_LARGE',
      error: refused('RESULT_TOO_LARGE'),
      attempts: 1,
      responseStarted: true,
      remainingMs: 10_000,
      random: 0.5,
      expected: { read: fail, write: fail, ddl: fail },
      retryable: { read: false, write: false, ddl: false },
    },
    {
      name: 'BATCH_TOO_LARGE with not_applied',
      error: refused('BATCH_TOO_LARGE', { writeOutcome: 'not_applied' }),
      attempts: 1,
      responseStarted: true,
      remainingMs: 10_000,
      random: 0.5,
      expected: { read: fail, write: fail, ddl: fail },
      retryable: { read: false, write: false, ddl: false },
    },
    {
      name: 'BATCH_TOO_LARGE with unknown',
      error: refused('BATCH_TOO_LARGE', { writeOutcome: 'unknown' }),
      attempts: 1,
      responseStarted: true,
      remainingMs: 10_000,
      random: 0.5,
      expected: { read: fail, write: fail, ddl: fail },
      retryable: { read: false, write: false, ddl: false },
    },
    {
      name: 'a refusal whose write outcome is unknown',
      error: refused('UNAVAILABLE', { writeOutcome: 'unknown' }),
      attempts: 1,
      responseStarted: true,
      remainingMs: 10_000,
      random: 0.5,
      expected: { read: fail, write: fail, ddl: fail },
      retryable: { read: false, write: false, ddl: false },
    },
    {
      name: 'an AUTH_FAIL',
      error: new AuthenticationError({ message: 'refused by the test', operation: 'auth' }),
      attempts: 1,
      responseStarted: true,
      remainingMs: 10_000,
      random: 0.5,
      expected: { read: fail, write: fail, ddl: fail },
      retryable: { read: false, write: false, ddl: false },
    },
    {
      name: 'a local refusal',
      error: new InvalidArgumentError({ message: 'refused by the test', operation: 'get' }),
      attempts: 1,
      responseStarted: true,
      remainingMs: 10_000,
      random: 0.5,
      expected: { read: fail, write: fail, ddl: fail },
      retryable: { read: false, write: false, ddl: false },
    },
  ];

  for (const row of rows) {
    for (const kind of ['read', 'write', 'ddl'] as const) {
      assert.deepEqual(
        decideRetry({
          error: row.error,
          kind,
          attempts: row.attempts ?? 1,
          responseStarted: row.responseStarted ?? false,
          remainingMs: row.remainingMs ?? 1_000,
          random: () => row.random ?? 0,
        }),
        row.expected[kind],
        `${row.name} as a ${kind} call`,
      );
      assert.equal(retryableFor(row.error, kind), row.retryable[kind], `${row.name}: retryable for a ${kind} call`);
    }
  }
});

test('a read is retried once after a connection loss before any response', async () => {
  const { run, server, stats } = await harness((frame, conn, seen) => {
    // The first GET dies with the socket; the second one is answered.
    if (seen === 1) conn.destroy();
    else conn.replyDoc(Op.GET_RESPONSE, frame.requestId, { found: true, data: { _id_: 'ada', Name: 'Ada' } });
  });

  const answer = await run(readSpec);

  assert.equal(answer['found'], true);
  assert.deepEqual(answer['data'], { _id_: 'ada', Name: 'Ada' });
  assert.equal(countOf(Op.GET), 2);
  assert.equal(stats.requests, 2);
  assert.equal(stats.retries, 1);
  assert.equal(server.connections.length, 2, 'the retry must be on a new connection');
});

test('a write is never retried after a connection loss and reports writeOutcome unknown', async () => {
  const { run, stats } = await harness((_frame, conn) => {
    conn.destroy();
  });

  await assert.rejects(run(writeSpec), (error: ConnectionError) => {
    assert.ok(error instanceof ConnectionError, 'a lost socket is a ConnectionError');
    assert.equal(error.code, 'CONNECTION_FAILED');
    assert.equal(error.writeOutcome, 'unknown');
    assert.match(error.message, /The outcome is unknown/);
    return true;
  });

  assert.equal(countOf(Op.PUT), 1, 'exactly one PUT reached the server');
  assert.equal(stats.retries, 0);
  assert.deepEqual(stats.errors, { CONNECTION_FAILED: 1 });
});

test('a pop is never retried', async () => {
  const { run, stats } = await harness((_frame, conn) => {
    conn.destroy();
  });

  await assert.rejects(
    run({
      operation: 'pop',
      target: 'app/events',
      op: 'FIFO_POP',
      fields: { database: 'app', bucket: 'events' },
      kind: 'write',
    }),
    (error: HoardDBError) => {
      assert.equal(error.code, 'CONNECTION_FAILED');
      assert.equal(error.writeOutcome, 'unknown');
      assert.equal(
        error.message.endsWith('outcome unknown: the pop may have removed up to 1 entries; run peek to see what is left.'),
        true,
        error.message,
      );
      return true;
    },
  );

  assert.equal(countOf(Op.FIFO_POP), 1);
  assert.equal(stats.retries, 0);
});

test('a lost pop of 3 says it may have removed up to 3 entries, and a lost push keeps the push sentence', async () => {
  const { run } = await harness((_frame, conn) => {
    conn.destroy();
  });

  for (const op of ['FIFO_POP', 'LIFO_POP', 'HEAP_POP', 'FIELD_POP'] as const) {
    await assert.rejects(
      run({
        operation: 'pop',
        target: 'app/events',
        op,
        fields: { database: 'app', bucket: 'events', limit: 3 },
        kind: 'write',
      }),
      (error: HoardDBError) => {
        assert.equal(error.writeOutcome, 'unknown');
        assert.match(error.message, /outcome unknown: the pop may have removed up to 3 entries; run peek to see what is left/);
        assert.equal(error.message.includes('do not resend a push'), false);
        return true;
      },
    );
  }

  await assert.rejects(run(writeSpec), (error: HoardDBError) => {
    assert.equal(error.message.endsWith(unknownOutcomeSentence), true);
    return true;
  });
});

test('a pop answered TIMEOUT (applied) says its answer carried no entries and is not retried', async () => {
  const { run, stats } = await harness((frame, conn) => {
    answerError(frame, conn, { code: 0x07, message: 'write concern not met in time', write_outcome: 'applied' });
  });

  await assert.rejects(
    run({
      operation: 'pop',
      target: 'app/events',
      op: 'FIFO_POP',
      fields: { database: 'app', bucket: 'events', limit: 4 },
      kind: 'write',
    }),
    (error: HoardDBError) => {
      assert.equal(error.code, 'TIMEOUT');
      assert.match(
        error.message,
        /the pop was applied or refused and its answer carried no entries: it may have removed up to 4 entries; run peek to see what is left/,
      );
      return true;
    },
  );
  assert.equal(countOf(Op.FIFO_POP), 1);
  assert.equal(stats.retries, 0);
});

test('UNAVAILABLE with not_applied is retried within the deadline', async () => {
  const { run, stats } = await harness((frame, conn, seen) => {
    if (seen === 1) {
      answerError(frame, conn, {
        code: 0x06,
        message: 'node is leaving the ring',
        write_outcome: 'not_applied',
      });
      return;
    }
    conn.replyDoc(Op.PUT, frame.requestId, { id: 'ada', success: true });
  });

  const answer = await run(writeSpec);

  assert.equal(answer['success'], true);
  assert.equal(answer['id'], 'ada');
  assert.equal(countOf(Op.PUT), 2);
  assert.equal(stats.retries, 1);
  assert.deepEqual(stats.errors, {});
});

test('TIMEOUT is never retried', async () => {
  const { run, stats } = await harness((frame, conn) => {
    answerError(frame, conn, { code: 0x07, message: 'the write concern was not met', write_outcome: 'unknown' });
  });

  await assert.rejects(run(writeSpec), (error: WriteConcernTimeoutError) => {
    assert.ok(error instanceof WriteConcernTimeoutError, 'TIMEOUT is WriteConcernTimeoutError');
    assert.equal(error.code, 'TIMEOUT');
    assert.equal(error.writeOutcome, 'unknown');
    return true;
  });

  assert.equal(countOf(Op.PUT), 1);
  assert.equal(stats.retries, 0);
  assert.deepEqual(stats.errors, { TIMEOUT: 1 });
});

test('an ERROR frame with INTERNAL discards the connection', async () => {
  const { run, server } = await harness((frame, conn, seen) => {
    if (seen === 1) {
      answerError(frame, conn, { code: 0x05, message: 'the store panicked' });
      return;
    }
    conn.replyDoc(Op.GET_RESPONSE, frame.requestId, { found: false });
  });

  await assert.rejects(run(readSpec), (error: InternalError) => {
    assert.ok(error instanceof InternalError, 'INTERNAL is InternalError');
    assert.equal(error.code, 'INTERNAL');
    assert.equal(error.retryable, false);
    return true;
  });

  const answer = await run(readSpec);

  assert.equal(answer['found'], false);
  assert.equal(server.connections.length, 2, 'a refused connection is dialled again, not reused');
});

test('an ERROR frame with NOT_FOUND keeps the connection', async () => {
  const { run, server } = await harness((frame, conn, seen) => {
    if (seen === 1) {
      answerError(frame, conn, { code: 0x01, message: 'bucket "users" not found in database "app"' });
      return;
    }
    conn.replyDoc(Op.GET_RESPONSE, frame.requestId, { found: true, data: { _id_: 'ada' } });
  });

  await assert.rejects(run(readSpec), (error: NotFoundError) => {
    assert.ok(error instanceof NotFoundError, 'NOT_FOUND is NotFoundError');
    assert.equal(error.code, 'NOT_FOUND');
    assert.equal(error.operation, 'get');
    assert.equal(error.target, 'app/users/ada');
    assert.equal(error.retryable, false);
    assert.match(String(error.requestId), /^[0-9a-f]{32}$/);
    return true;
  });

  const answer = await run(readSpec);

  assert.equal(answer['found'], true);
  assert.equal(server.connections.length, 1, 'the next call must reuse the same connection');
  assert.equal(countOf(Op.GET), 2);
});

test('a frame over the limit is refused before sending', async () => {
  const { run, server } = await harness(answerDoc(Op.PUT, { id: 'ada', success: true }));

  await run(writeSpec);
  const bytesBefore = server.totalBytesReceived();

  await assert.rejects(
    run({ ...writeSpec, fields: { ...writeSpec.fields, data: new Uint8Array(MAX_LENGTH) } }),
    (error: FrameTooLargeError) => {
      assert.ok(error instanceof FrameTooLargeError, 'an oversized frame is FrameTooLargeError');
      assert.equal(error.code, 'FRAME_TOO_LARGE');
      assert.match(
        error.message,
        new RegExp(
          `^This put encodes to [0-9]+ bytes; a frame holds at most ${MAX_LENGTH} \\(1 \\+ 16 \\+ payload ≤ 32 MiB\\)\\. Nothing was sent\\. Split it into smaller batches, or store a large value as a blob\\.$`,
        ),
      );
      return true;
    },
  );

  assert.equal(server.totalBytesReceived(), bytesBefore, 'not one byte may reach the server');
  assert.equal(countOf(Op.PUT), 1, 'the oversized PUT was never sent');
});

test('a 20 MiB put encodes and sends', async () => {
  const value = new Uint8Array(20 * 1024 * 1024);
  let receivedPayloadBytes = 0;
  const { run } = await harness((frame, conn) => {
    receivedPayloadBytes = frame.payload.length;
    conn.replyDoc(Op.PUT, frame.requestId, { id: 'ada', success: true });
  });

  const answer = await run({ ...writeSpec, fields: { ...writeSpec.fields, data: value } });

  assert.equal(answer['success'], true);
  assert.equal(countOf(Op.PUT), 1, 'the PUT went out once');
  assert.ok(receivedPayloadBytes > value.length, `the server got ${receivedPayloadBytes} payload bytes`);
});

test('writeConcern quorum is refused locally', async () => {
  const { ctx, run, server } = await harness();
  const bytesBefore = server.totalBytesReceived();

  assert.throws(
    () => validateWriteConcern('quorum', ctx, 'put'),
    (error: InvalidArgumentError) => {
      assert.ok(error instanceof InvalidArgumentError, 'a bad writeConcern is an InvalidArgumentError');
      assert.equal(error.code, 'INVALID_ARGUMENT');
      assert.equal(error.message, 'writeConcern "quorum" is not one of one, majority, all.');
      assert.equal(error.operation, 'put');
      return true;
    },
  );

  // A program written in JavaScript can pass a word the types forbid; the call still refuses it.
  const typedForJavaScript = { writeConcern: 'quorum' } as unknown as CallSpec['opts'];
  await assert.rejects(run({ ...writeSpec, opts: typedForJavaScript }), (error: InvalidArgumentError) => {
    assert.equal(error.code, 'INVALID_ARGUMENT');
    assert.equal(error.message, 'writeConcern "quorum" is not one of one, majority, all.');
    return true;
  });
  assert.equal(server.totalBytesReceived(), bytesBefore);
  assert.equal(validateWriteConcern(undefined, ctx, 'put'), undefined, 'no concern means the field is omitted');
  assert.equal(validateWriteConcern('majority', ctx, 'put'), 'majority');
});

test('writeConcern without the capability is UnsupportedFeatureError', async () => {
  const { ctx } = await harness(() => undefined, ['pipelining', 'get_fast']);

  assert.throws(
    () => validateWriteConcern('majority', ctx, 'put'),
    (error: UnsupportedFeatureError) => {
      assert.ok(error instanceof UnsupportedFeatureError);
      assert.equal(error.code, 'UNSUPPORTED_FEATURE');
      assert.equal(
        error.message,
        'This server (fake) does not advertise "write_concern", so { writeConcern: \'majority\' } cannot be honoured. Nothing was sent. Upgrade the server, or leave the option out.',
      );
      return true;
    },
  );
});

test('a cancelled call does not poison the pool', async () => {
  let hold = true;
  const { run, pool, server, stats } = await harness((frame, conn) => {
    if (hold) return;
    conn.replyDoc(Op.GET_RESPONSE, frame.requestId, { found: true, data: { _id_: 'ada' } });
  });

  const controller = new AbortController();
  const cancelled = run({ ...readSpec, opts: { signal: controller.signal } });
  await waitFor('the request to reach the server', () => countOf(Op.GET) === 1);
  controller.abort();

  await assert.rejects(cancelled, (error: HoardDBError) => {
    assert.equal(error.code, 'ABORTED');
    return true;
  });

  hold = false;
  const answer = await run(readSpec);

  assert.equal(answer['found'], true);
  assert.equal(server.connections.length, 2, 'the cancelled connection was dialled again');
  assert.equal(pool.stats().point.open, 1);
  assert.equal(pool.stats().point.inUse, 0);
  assert.equal(stats.retries, 0, 'an abort is the caller saying stop, not a failure to retry');
});
/** The sentence the server writes when its connection budget is full (transport/tcp.go refuseMessage). */
const BUDGET_FULL =
  'server connection limit reached (1, HOARDDB_TCP_MAX_CONNS_PER_IP); retry shortly or raise the cap (currently 1 connections)';

/** What the real server does to a connection over its cap: refuse before AUTH, then close. */
function refuseOverBudget(conn: FakeConnection): void {
  conn.replyDoc(Op.ERROR, new Uint8Array(16), { code: 13, message: BUDGET_FULL });
  conn.end();
}

test('OVERLOADED on a dial is retried with backoff and the write then succeeds', async () => {
  let refused = 0;
  const { run, server, stats } = await harness(
    answerDoc(Op.PUT, { id: 'ada', success: true }),
    AUTH_CAPABILITIES,
    (conn) => {
      if (refused > 0) return;
      refused += 1;
      refuseOverBudget(conn);
    },
  );

  const answer = await run(writeSpec);

  assert.equal(answer['success'], true);
  assert.equal(refused, 1);
  assert.equal(countOf(Op.PUT), 1, 'the write went out once, on the dial that was let in');
  assert.equal(stats.retries, 1);
  assert.deepEqual(stats.errors, {});
  assert.equal(server.connections.length, 2);
});

test('a write refused OVERLOADED on every dial stays retryable and is not marked unknown', async () => {
  const { run, stats } = await harness(answerDoc(Op.PUT, { id: 'ada', success: true }), AUTH_CAPABILITIES, refuseOverBudget);

  await assert.rejects(run({ ...writeSpec, opts: { timeoutMs: 300 } }), (error: OverloadedError) => {
    assert.ok(error instanceof OverloadedError, `expected OverloadedError, got ${String(error)}`);
    assert.equal(error.message, BUDGET_FULL, 'nothing was sent, so no unknown-outcome sentence');
    assert.notEqual(error.writeOutcome, 'unknown');
    assert.equal(error.retryable, true, 'repeating it is safe: the write never left this process');
    assert.equal(error.operation, 'put');
    assert.equal(error.target, 'app/users/ada');
    return true;
  });

  assert.equal(countOf(Op.PUT), 0);
  assert.ok(stats.retries >= 1, `the dial was retried ${stats.retries} times`);
  assert.deepEqual(stats.errors, { OVERLOADED: 1 });
});

test('a call whose dial outlives its deadline is REQUEST_TIMEOUT and sends nothing', async () => {
  // The login takes 400 ms; the call has 150. Before the fix the dial ran on its own 5 s budget and
  // the PUT was written after the call's deadline with a timeout of zero: sent, and reported unknown.
  const { run, stats } = await harness(answerDoc(Op.PUT, { id: 'ada', success: true }), AUTH_CAPABILITIES, undefined, 400);
  const started = Date.now();

  await assert.rejects(run({ ...writeSpec, opts: { timeoutMs: 150 } }), (error: HoardDBError) => {
    assert.equal(error.code, 'REQUEST_TIMEOUT', error.message);
    assert.equal(error.writeOutcome, 'not_applied');
    assert.equal(error.operation, 'put');
    assert.equal(error.target, 'app/users/ada');
    assert.equal(error.message.includes(unknownOutcomeSentence), false);
    assert.equal(
      error.message,
      'put on app/users/ada timed out after 150 ms before it was sent (no connection was ready in time). Nothing was sent, so it is safe to repeat. For a slow call raise { timeoutMs }.',
    );
    return true;
  });
  const tookMs = Date.now() - started;

  assert.ok(tookMs < 350, `the call took ${tookMs} ms against a 150 ms deadline`);
  await sleep(400);
  assert.equal(countOf(Op.PUT), 0, 'no PUT may reach the server after the deadline');
  assert.deepEqual(stats.errors, { REQUEST_TIMEOUT: 1 });
});

test('an abort during the retry backoff is seen at once', async () => {
  const { ctx } = await harness((frame, conn) => {
    answerError(frame, conn, { code: 0x06, message: 'node is leaving the ring', write_outcome: 'not_applied' });
  });
  const controller = new AbortController();
  // random() = 1 makes each backoff its full length: 100, 200, 400, then 800 ms after the fourth PUT.
  const pending = call({ ...ctx, random: () => 1 }, { ...writeSpec, opts: { signal: controller.signal, timeoutMs: 10_000 } });
  await waitFor('the fourth refusal', () => countOf(Op.PUT) === 4);
  await sleep(20);
  const abortedAt = Date.now();
  controller.abort();

  await assert.rejects(pending, (error: HoardDBError) => {
    assert.equal(error.code, 'ABORTED');
    assert.equal(error.message, 'put on app/users/ada was aborted.');
    assert.equal(error.operation, 'put');
    assert.equal(error.target, 'app/users/ada');
    assert.equal(error.writeOutcome, 'not_applied', 'every attempt before the abort was refused not_applied');
    return true;
  });
  const lateMs = Date.now() - abortedAt;
  assert.ok(lateMs < 150, `the abort was seen ${lateMs} ms late`);
  assert.equal(countOf(Op.PUT), 4);
});

test("a refusal from the pool carries the call's operation and target", async () => {
  const { run, pool, stats } = await harness();
  const held = await Promise.all(Array.from({ length: BASE_CONFIG.size }, () => pool.acquire('point', Date.now() + 5_000)));

  await assert.rejects(run({ ...readSpec, opts: { timeoutMs: 100 } }), (error: HoardDBError) => {
    assert.equal(error.code, 'POOL_TIMEOUT');
    assert.equal(error.operation, 'get');
    assert.equal(error.target, 'app/users/ada');
    return true;
  });

  const controller = new AbortController();
  const waiting = run({ ...readSpec, opts: { signal: controller.signal } });
  await sleep(20);
  controller.abort();
  await assert.rejects(waiting, (error: HoardDBError) => {
    assert.equal(error.code, 'ABORTED');
    // Build doc section 5.2: '<operation> on <target> was aborted.'
    assert.equal(error.message, 'get on app/users/ada was aborted.');
    assert.equal(error.operation, 'get');
    assert.equal(error.target, 'app/users/ada');
    return true;
  });

  assert.deepEqual(stats.errors, { POOL_TIMEOUT: 1, ABORTED: 1 });
  for (const lease of held) lease.release();
});

test('an abort during a dial is seen at once', async () => {
  const { run, pool } = await harness(answerDoc(Op.GET_RESPONSE, { found: false }), AUTH_CAPABILITIES, undefined, 2_000);
  const controller = new AbortController();
  const pending = run({ ...readSpec, opts: { signal: controller.signal } });
  await sleep(50);
  const abortedAt = Date.now();
  controller.abort();

  await assert.rejects(pending, (error: HoardDBError) => {
    assert.equal(error.code, 'ABORTED');
    assert.equal(error.message, 'get on app/users/ada was aborted.');
    return true;
  });
  const lateMs = Date.now() - abortedAt;
  assert.ok(lateMs < 200, `the abort was seen ${lateMs} ms late, after the login finished`);
  assert.equal(pool.stats().point.open, 0, 'the half-dialled socket was not kept');
});

test('a success answer that does not decode discards the connection', async () => {
  const { run, server } = await harness((frame, conn, seen) => {
    // A GET_RESPONSE whose payload is not a BSON document: the stream it came on cannot be trusted.
    if (seen === 1) conn.reply(Op.GET_RESPONSE, frame.requestId, new Uint8Array([0x05, 0x00, 0x00, 0x00, 0x01]));
    else conn.replyDoc(Op.GET_RESPONSE, frame.requestId, { found: false });
  });

  await assert.rejects(run(readSpec), (error: HoardDBError) => {
    assert.equal(error.code, 'PROTOCOL_ERROR', error.message);
    assert.equal(error.operation, 'get');
    assert.equal(error.target, 'app/users/ada');
    assert.match(error.message, /^The server at 127\.0\.0\.1:[0-9]+ sent a GET answer that does not decode \(.+\)\. The connection was discarded\.$/);
    return true;
  });

  const answer = await run(readSpec);
  assert.equal(answer['found'], false);
  assert.equal(server.connections.length, 2, 'the connection that sent it was not reused');
});

test('a write refused before a byte of it was written reports not_applied', async () => {
  const { ctx, pool, stats } = await harness(answerDoc(Op.PUT, { id: 'ada', success: true }));
  const lease = await pool.acquire('point', Date.now() + 5_000);
  const dead = lease.connection;
  lease.release();
  dead.destroy();
  // A pool that hands out a socket which closed between the hand-out and the write: the race this
  // guards against, made certain.
  const handsOutDead = {
    acquire: async () => ({ connection: dead, release: () => undefined, discard: () => undefined }),
  } as unknown as Pool;

  await assert.rejects(call({ ...ctx, pool: handsOutDead }, writeSpec), (error: HoardDBError) => {
    assert.equal(error.code, 'CONNECTION_FAILED');
    assert.equal(error.writeOutcome, 'not_applied', 'send threw before writing, so nothing was applied');
    assert.equal(error.message.includes(unknownOutcomeSentence), false);
    return true;
  });

  assert.equal(countOf(Op.PUT), 0);
  assert.deepEqual(stats.errors, { CONNECTION_FAILED: 1 });
});

test('a refusal raised before sending is counted and names the target', async () => {
  const { run, stats, server } = await harness();
  const bytesBefore = server.totalBytesReceived();

  const typedForJavaScript = { writeConcern: 'quorum' } as unknown as CallSpec['opts'];
  await assert.rejects(run({ ...writeSpec, opts: typedForJavaScript }), (error: HoardDBError) => {
    assert.equal(error.code, 'INVALID_ARGUMENT');
    assert.equal(error.operation, 'put');
    assert.equal(error.target, 'app/users/ada');
    return true;
  });
  await assert.rejects(run({ ...writeSpec, fields: { ...writeSpec.fields, bogus: 1 } }), (error: HoardDBError) => {
    assert.equal(error.code, 'INVALID_ARGUMENT');
    assert.match(error.message, /no wire field "bogus"/);
    assert.equal(error.operation, 'put');
    assert.equal(error.target, 'app/users/ada');
    return true;
  });

  assert.deepEqual(stats.errors, { INVALID_ARGUMENT: 2 }, 'poolStats counts what the program saw');
  assert.equal(server.totalBytesReceived(), bytesBefore);
});

test('a write whose dial fails reports not_applied and is safe to repeat', async () => {
  const { ctx, stats } = await harness();
  const probe = await startFakeServer({ identity, onFrame: () => undefined });
  const deadPort = probe.port;
  await probe.close();
  const deadPool = new Pool({
    hosts: [{ host: '127.0.0.1', port: deadPort, hostIndex: 0 }],
    trust: makeTrustPolicy({ fingerprints: [identity.fingerprint], knownServersPath: false }, [], 1),
    dialTimeoutMs: 5_000,
    session: new Session({ username: 'admin', password: PASSWORD }, Date.now),
    config: BASE_CONFIG,
    now: Date.now,
    random: () => 0,
    onAuth: () => undefined,
  });
  pools.push(deadPool);

  await assert.rejects(call({ ...ctx, pool: deadPool }, writeSpec), (error: HoardDBError) => {
    assert.equal(error.code, 'CONNECTION_FAILED');
    assert.equal(error.writeOutcome, 'not_applied', 'the dial failed, so nothing was written');
    assert.equal(error.retryable, true, 'repeating a write that never left the process is safe');
    assert.equal(error.message.includes(unknownOutcomeSentence), false);
    assert.equal(error.operation, 'put');
    assert.equal(error.target, 'app/users/ada');
    return true;
  });
  assert.deepEqual(stats.errors, { CONNECTION_FAILED: 1 });
});

test('a timeout or an abort mid-send names the call, not the connection', async () => {
  const { run } = await harness(() => undefined);

  // An insert travels as PUT to the bucket; the caller knows it as "insert on app/users".
  await assert.rejects(
    run({ ...writeSpec, operation: 'insert', target: 'app/users', fields: { database: 'app', bucket: 'users', key: '', data: { Name: 'Ada' } }, opts: { timeoutMs: 150 } }),
    (error: HoardDBError) => {
      assert.equal(error.code, 'REQUEST_TIMEOUT');
      assert.equal(error.operation, 'insert');
      assert.equal(error.target, 'app/users');
      assert.equal(
        error.message,
        `insert on app/users timed out after 150 ms. For a slow call raise { timeoutMs }; the connection was discarded. ${unknownOutcomeSentence}`,
      );
      assert.equal(error.writeOutcome, 'unknown', 'the PUT was written and never answered');
      return true;
    },
  );

  const controller = new AbortController();
  const pending = run({ ...readSpec, operation: 'find', target: 'app/users', op: 'SCAN', fields: { database: 'app', bucket: 'users' }, opts: { signal: controller.signal } });
  await waitFor('the SCAN to reach the server', () => countOf(Op.SCAN) === 1);
  controller.abort();
  await assert.rejects(pending, (error: HoardDBError) => {
    assert.equal(error.code, 'ABORTED');
    assert.equal(error.operation, 'find');
    assert.equal(error.target, 'app/users');
    assert.equal(error.message, 'find on app/users was aborted.');
    assert.equal(error.writeOutcome, undefined, 'a read has no write outcome');
    return true;
  });
});

test('a deadline that ends an OVERLOADED wait reports the server sentence and not_applied', async () => {
  let refused = 0;
  // The first connection is refused over budget; the next one's login never answers, so the call's
  // deadline cuts that dial short while the refusal is being waited out.
  const { run } = await harness(
    answerDoc(Op.PUT, { id: 'ada', success: true }),
    AUTH_CAPABILITIES,
    (conn) => {
      if (refused > 0) return;
      refused += 1;
      refuseOverBudget(conn);
    },
    10_000,
  );

  await assert.rejects(run({ ...writeSpec, opts: { timeoutMs: 300 } }), (error: HoardDBError) => {
    assert.ok(error instanceof OverloadedError, `expected OverloadedError, got ${String(error)}`);
    assert.equal(error.message, BUDGET_FULL);
    assert.equal(error.writeOutcome, 'not_applied', 'nothing of the write left the process');
    assert.equal(error.retryable, true);
    return true;
  });
  assert.equal(countOf(Op.PUT), 0);
});

const createDatabaseSpec: CallSpec = {
  operation: 'createDatabase',
  target: 'smoke',
  op: 'CREATE_DB',
  lane: 'point',
  kind: 'ddl',
  fields: { name: 'smoke' },
};

test('a server refusal to a DDL call is not an unknown outcome', async () => {
  const { run } = await harness((frame, conn) => {
    answerError(frame, conn, { code: 0x02, message: 'database "smoke" already exists' });
  });

  // Seen on a real server before the fix: 'database "smoke" already exists The outcome is unknown:
  // read it back before resending, and do not resend a push, a pop or an increment.' A refusal says
  // nothing changed (handbook errors.md section 4: no outcome is normal for a DDL request).
  await assert.rejects(run(createDatabaseSpec), (error: HoardDBError) => {
    assert.equal(error.code, 'ALREADY_EXISTS');
    assert.equal(error.message, 'database "smoke" already exists', "the server's sentence and nothing else");
    assert.equal(error.writeOutcome, undefined);
    return true;
  });
});

test('a DDL call lost after sending says read it back, without the push sentence', async () => {
  const { run } = await harness((_frame, conn) => conn.destroy());

  await assert.rejects(run(createDatabaseSpec), (error: HoardDBError) => {
    assert.equal(error.code, 'CONNECTION_FAILED');
    assert.equal(error.writeOutcome, 'unknown', 'the CREATE_DB went out and no answer came back');
    // Section 5.2: during a call, 'The connection to <host:port> failed during <operation> (<reason>).'
    assert.match(error.message, /^The connection to 127\.0\.0\.1:[0-9]+ failed during createDatabase \(/);
    assert.ok(error.message.endsWith(' The outcome is unknown: read it back before resending.'), error.message);
    assert.equal(error.message.includes('push'), false, 'a DDL call is not a push, a pop or an increment');
    return true;
  });
  assert.equal(countOf(Op.CREATE_DB), 1, 'a DDL call is never resent');
});

test('a write refused before sending reports not_applied', async () => {
  const { run, stats, server } = await harness(() => undefined, ['pipelining', 'get_fast']);
  const bytesBefore = server.totalBytesReceived();

  // Section 5.2: a refusal about a write raised before it was written carries not_applied.
  await assert.rejects(run({ ...writeSpec, opts: { writeConcern: 'majority' } }), (error: HoardDBError) => {
    assert.equal(error.code, 'UNSUPPORTED_FEATURE');
    assert.equal(error.writeOutcome, 'not_applied');
    assert.equal(error.target, 'app/users/ada');
    return true;
  });

  assert.deepEqual(stats.errors, { UNSUPPORTED_FEATURE: 1 });
  assert.equal(server.totalBytesReceived(), bytesBefore, 'nothing was sent');
});

// ---------------------------------------------------------------- OVERLOADED after a send
// The server's OVERLOADED is a connection-level refusal with an all-zero request ID: it serves nothing,
// so a write it answers may be backed off and sent again. An OVERLOADED that carries a request ID
// answers one request, which may have been applied: a write is then never resent (README, Errors).

const OVERLOAD_SENTENCE = 'server connection limit reached (1, HOARDDB_TCP_MAX_CONNS_PER_IP); retry shortly or raise the cap (currently 1 connections)';

const ZERO_ID = new Uint8Array(16);

/** An OVERLOADED that answers this very request (a non-zero request ID), then the next call succeeds. */
function overloadedOnce(opcode: number, success: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return (frame: Frame, conn: FakeConnection, seen: number): void => {
    if (seen === 1) answerError(frame, conn, { code: 13, message: OVERLOAD_SENTENCE, ...extra });
    else conn.replyDoc(opcode, frame.requestId, success);
  };
}

const fifoPushSpec: CallSpec = {
  operation: 'push',
  target: 'app/events',
  op: 'FIFO_PUSH',
  lane: 'point',
  kind: 'write',
  fields: { database: 'app', bucket: 'events', data: { n: 1 } },
};

const updateSpec: CallSpec = {
  operation: 'update',
  target: 'app/users/ada',
  op: 'UPDATE',
  lane: 'point',
  kind: 'write',
  fields: { database: 'app', bucket: 'users', key: 'ada', set: { Name: 'Ada' } },
};

for (const [name, spec, opcode] of [
  ['a hash put', writeSpec, Op.PUT],
  ['a fifo push', fifoPushSpec, Op.FIFO_PUSH],
  ['an update', updateSpec, Op.UPDATE],
] as const) {
  test(`${name} answered OVERLOADED with a request ID is sent once and reported unknown`, async () => {
    const { run, stats } = await harness(overloadedOnce(opcode, { success: true, id: 'ada' }));
    await assert.rejects(run(spec), (error: HoardDBError) => {
      assert.ok(error instanceof OverloadedError, `expected OverloadedError, got ${String(error)}`);
      assert.equal(error.writeOutcome, 'unknown');
      assert.equal(error.message, `${OVERLOAD_SENTENCE} ${unknownOutcomeSentence}`);
      assert.equal(error.retryable, false, 'the caller reads it back first');
      return true;
    });
    assert.equal(countOf(opcode), 1, 'never resent');
    assert.equal(stats.retries, 0);
  });
}

test('a DDL request answered OVERLOADED with a request ID is sent once and reported unknown', async () => {
  const { run } = await harness(overloadedOnce(Op.CREATE_DB, { success: true }));
  await assert.rejects(run(createDatabaseSpec), (error: HoardDBError) => {
    assert.ok(error instanceof OverloadedError, `expected OverloadedError, got ${String(error)}`);
    assert.equal(error.writeOutcome, 'unknown');
    assert.equal(error.message, `${OVERLOAD_SENTENCE} ${unknownDdlOutcomeSentence}`);
    assert.equal(error.retryable, false);
    return true;
  });
  assert.equal(countOf(Op.CREATE_DB), 1, 'never resent');
});

test('an OVERLOADED the server stamped not_applied is still resent, as before', async () => {
  const { run } = await harness(overloadedOnce(Op.PUT, { success: true, id: 'ada' }, { write_outcome: 'not_applied' }));
  assert.equal((await run(writeSpec))['success'], true);
  assert.equal(countOf(Op.PUT), 2);
});

test('an OVERLOADED the server stamped unknown is not resent and keeps its stamp', async () => {
  const { run } = await harness(overloadedOnce(Op.PUT, { success: true }, { write_outcome: 'unknown' }));
  await assert.rejects(run(writeSpec), (error: HoardDBError) => {
    assert.equal(error.writeOutcome, 'unknown');
    return true;
  });
  assert.equal(countOf(Op.PUT), 1);
});

test('a zero-ID OVERLOADED after a write was sent is backed off and the write resent', async () => {
  const { run, stats } = await harness((frame, conn, seen) => {
    if (seen === 1) {
      conn.replyDoc(Op.ERROR, ZERO_ID, { code: 13, message: OVERLOAD_SENTENCE });
      conn.end();
    } else {
      conn.replyDoc(Op.PUT, frame.requestId, { success: true, id: 'ada' });
    }
  });
  assert.equal((await run(writeSpec))['success'], true);
  assert.equal(countOf(Op.PUT), 2, 'the server served nothing, so the write goes again');
  assert.equal(stats.retries, 1);
});

test('a zero-ID OVERLOADED after a DDL request was sent is resent too', async () => {
  const { run } = await harness((frame, conn, seen) => {
    if (seen === 1) {
      conn.replyDoc(Op.ERROR, ZERO_ID, { code: 13, message: OVERLOAD_SENTENCE });
      conn.end();
    } else {
      conn.replyDoc(Op.CREATE_DB, frame.requestId, { success: true });
    }
  });
  await run(createDatabaseSpec);
  assert.equal(countOf(Op.CREATE_DB), 2);
});

test('a read answered OVERLOADED with a request ID is still resent', async () => {
  const { run } = await harness(overloadedOnce(Op.GET_RESPONSE, { found: true, data: { Name: 'Ada' } }));
  assert.equal((await run(readSpec))['found'], true);
  assert.equal(countOf(Op.GET), 2);
});

test('a write the server never has room for makes a bounded number of attempts under a deadline', async () => {
  const { ctx } = await harness((_frame, conn) => {
    conn.replyDoc(Op.ERROR, ZERO_ID, { code: 13, message: OVERLOAD_SENTENCE });
    conn.end();
  });
  // random() = 1 makes each wait its full length: 100, 200, 400, 800, 1600 ms. In a 2 s deadline that is
  // at most 5 sends; 12 is generous slack for timers, and far below the thousands a missing backoff makes.
  await assert.rejects(call({ ...ctx, random: () => 1 }, { ...writeSpec, opts: { timeoutMs: 2_000 } }), (error: HoardDBError) => {
    assert.equal(error.code, 'OVERLOADED');
    return true;
  });
  const sends = countOf(Op.PUT);
  assert.ok(sends >= 2 && sends <= 12, `${sends} sends in a 2 s deadline`);
});

// ---- a value the driver refuses to read: its own error, a healthy connection, an applied write ----

const refusedDoc = document(
  element(0x08, 'found', new Uint8Array([1])),
  element(0x03, 'data', document(stringElement('_id_', 'ada'), outOfRangeDate('when'))),
);

test('a refused value is an UnreadableValueError, not an undecodable answer, and the connection is kept', async () => {
  const { run, server } = await harness((frame, conn) => conn.reply(Op.GET_RESPONSE, frame.requestId, refusedDoc));

  for (let attempt = 0; attempt < 2; attempt += 1) {
    await assert.rejects(run(readSpec), (error: unknown) => {
      assert.ok(error instanceof UnreadableValueError, `expected an UnreadableValueError, got ${String(error)}`);
      assert.equal(error.code, 'UNREADABLE_VALUE');
      assert.equal(error.document, 'ada');
      assert.equal(error.field, 'when');
      assert.equal(error.operation, 'get');
      assert.equal(error.target, 'app/users/ada');
      assert.doesNotMatch(error.message, /does not decode|discarded/, 'the server is not blamed');
      assert.equal(error.writeOutcome, undefined, 'a read has no outcome to report');
      assert.equal(error.retryable, false);
      return true;
    });
  }
  assert.equal(server.connections.length, 1, 'the healthy connection was not thrown away');
});

test('an update whose reply holds a refused value is reported as applied, once, and not retryable', async () => {
  const reply = document(element(0x08, 'success', new Uint8Array([1])), element(0x03, 'doc', document(stringElement('_id_', 'ada'), outOfRangeDate('when'))));
  const { run, stats } = await harness((frame, conn) => conn.reply(Op.UPDATE, frame.requestId, reply));
  const updateSpec: Partial<CallSpec> = {
    operation: 'update',
    target: 'app/users/ada',
    op: 'UPDATE',
    kind: 'write',
    fields: { database: 'app', bucket: 'users', key: 'ada', set: { n: 1 } },
  };

  await assert.rejects(run(updateSpec), (error: unknown) => {
    assert.ok(error instanceof UnreadableValueError, `expected an UnreadableValueError, got ${String(error)}`);
    assert.equal(error.writeOutcome, 'applied');
    assert.equal(error.retryable, false);
    assert.match(error.message, /applied/);
    assert.match(error.message, /do not send it again|not send it again/i);
    assert.doesNotMatch(error.message, /outcome is unknown/);
    assert.equal(error.document, 'ada');
    return true;
  });
  assert.equal(countOf(Op.UPDATE), 1, 'the update was sent once');
  assert.deepEqual(stats.errors, { UNREADABLE_VALUE: 1 });
});

test('a find page with one refused document fails as a whole and names the document and the field', async () => {
  const page = document(
    element(0x08, 'found', new Uint8Array([1])),
    element(
      0x04,
      'documents',
      document(
        element(0x03, '0', document(stringElement('_id_', 'ada'))),
        element(0x03, '1', document(stringElement('_id_', 'zed'), outOfRangeDate('born'))),
      ),
    ),
  );
  const { run } = await harness((frame, conn) => conn.reply(Op.SCAN, frame.requestId, page));

  await assert.rejects(run({ operation: 'find', target: 'app/users', op: 'SCAN', fields: { database: 'app', bucket: 'users' } }), (error: unknown) => {
    assert.ok(error instanceof UnreadableValueError);
    assert.equal(error.document, 'zed');
    assert.equal(error.index, 1);
    assert.equal(error.field, 'born');
    assert.match(error.message, /"zed"/);
    return true;
  });
});

test('an answer that genuinely does not decode is still a ProtocolError that discards the connection', async () => {
  const { run, server } = await harness((frame, conn) => conn.reply(Op.GET_RESPONSE, frame.requestId, new Uint8Array([0x05, 0, 0, 0, 1])));
  await assert.rejects(run(readSpec), (error: unknown) => error instanceof ProtocolError && /does not decode/.test(error.message));
  await assert.rejects(run(readSpec), ProtocolError);
  assert.equal(server.connections.length, 2, 'each undecodable answer cost its connection');
});

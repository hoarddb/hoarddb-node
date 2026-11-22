// SPDX-License-Identifier: Apache-2.0
//
// The connection, against an in-process fake server with a real TLS 1.3 handshake. Two orders are
// proven here and nowhere else can they be broken quietly: the key is checked before the first byte
// is written, and an answer is matched to the request ID it was sent with.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { decodeDocument } from '../../src/codec/index.js';
import { Connection } from '../../src/connection.js';
import {
  AbortedError,
  OverloadedError,
  ProtocolError,
  RequestTimeoutError,
  TlsTrustError,
  type HoardDBError,
} from '../../src/errors.js';
import { makeTrustPolicy, type TrustOptions, type TrustPolicy } from '../../src/trust.js';
import { HEADER_BYTES, MAX_LENGTH, newRequestId } from '../../src/wire/frame.js';
import { Op } from '../../src/wire/opcodes.js';
import { startFakeServer, type FakeServer } from '../helpers/fake-server.js';
import { makeTlsIdentity, removeTlsIdentity, type TlsIdentity } from '../helpers/tls-identity.js';

/** A well-formed fingerprint no server here holds, so a pin against it cannot match by accident. */
const OTHER_FINGERPRINT = `SHA256:${'ab'.repeat(32)}`;

let identity: TlsIdentity;
const servers: FakeServer[] = [];
const connections: Connection[] = [];

before(() => {
  identity = makeTlsIdentity();
});

after(async () => {
  for (const connection of connections) connection.destroy();
  for (const server of servers) await server.close();
  removeTlsIdentity(identity);
});

async function fakeServer(
  onFrame: Parameters<typeof startFakeServer>[0]['onFrame'],
  alpn?: string[] | false,
): Promise<FakeServer> {
  const server = await startFakeServer(alpn === undefined ? { identity, onFrame } : { identity, alpn, onFrame });
  servers.push(server);
  return server;
}

function policyWith(options: TrustOptions): TrustPolicy {
  return makeTrustPolicy(options, [], 1);
}

const pinned = (): TrustPolicy => policyWith({ fingerprints: [identity.fingerprint], knownServersPath: false });

async function dial(server: FakeServer, trust: TrustPolicy = pinned()): Promise<Connection> {
  const connection = await Connection.dial({
    target: { host: '127.0.0.1', port: server.port, hostIndex: 0 },
    trust,
    dialTimeoutMs: 5_000,
  });
  connections.push(connection);
  return connection;
}

function closedBy(connection: Connection): Promise<HoardDBError | undefined> {
  return new Promise((resolveClose) => connection.onClose(resolveClose));
}

async function rejects(error: unknown): Promise<HoardDBError> {
  try {
    await Promise.resolve(error);
  } catch (caught) {
    return caught as HoardDBError;
  }
  throw new Error('the call resolved, which this test expected to fail');
}

test('dial with a matching pin succeeds and sends nothing', async () => {
  const server = await fakeServer(() => undefined);
  const connection = await dial(server);

  assert.equal(connection.address, `127.0.0.1:${server.port}`);
  assert.equal(connection.fingerprint, identity.fingerprint);
  assert.equal(connection.maxInFlight, 1);
  assert.equal(connection.inFlight, 0);
  assert.equal(connection.closed, false);
  assert.equal(server.totalBytesReceived(), 0);
});

test('a pin mismatch sends zero bytes', async () => {
  const server = await fakeServer(() => undefined);

  await assert.rejects(
    Connection.dial({
      target: { host: '127.0.0.1', port: server.port, hostIndex: 0 },
      trust: policyWith({ fingerprints: [OTHER_FINGERPRINT], knownServersPath: false }),
      dialTimeoutMs: 5_000,
    }),
    (error: TlsTrustError) => {
      assert.equal(error.code, 'TLS_FINGERPRINT_MISMATCH');
      assert.equal(error.target, `127.0.0.1:${server.port}`);
      assert.match(error.message, /Nothing was sent|Refusing to connect/);
      return true;
    },
  );
  assert.equal(server.totalBytesReceived(), 0);
});

test('an unknown key with no prompt sends zero bytes', async () => {
  const server = await fakeServer(() => undefined);

  await assert.rejects(
    Connection.dial({
      target: { host: '127.0.0.1', port: server.port, hostIndex: 0 },
      trust: policyWith({ knownServersPath: false }),
      dialTimeoutMs: 5_000,
    }),
    (error: TlsTrustError) => {
      assert.equal(error.code, 'TLS_UNTRUSTED');
      assert.equal(error.target, `127.0.0.1:${server.port}`);
      assert.match(error.message, /your password never left this process/);
      return true;
    },
  );
  assert.equal(server.totalBytesReceived(), 0);
});

test('bytes the server sends before its key is decided are not read', async () => {
  const MIB = 1024 * 1024;
  let pendingAtDecision = -1;
  const server = await startFakeServer({
    identity,
    onFrame: () => undefined,
    onConnect: (conn) => {
      // A legal 32 MiB frame header, then 16 MiB of its body, before the client has said a word.
      const header = new Uint8Array(HEADER_BYTES);
      header[0] = 1;
      new DataView(header.buffer).setUint32(1, MAX_LENGTH, true);
      header[5] = Op.GET_RESPONSE;
      conn.writeRaw(header);
      conn.writeRaw(new Uint8Array(16 * MIB));
    },
  });
  servers.push(server);

  await assert.rejects(
    Connection.dial({
      target: { host: '127.0.0.1', port: server.port, hostIndex: 0 },
      trust: policyWith({
        knownServersPath: false,
        // The program's prompt is slow (a person, a file read): an untrusted peer must not be able
        // to fill this process's memory while it runs.
        onUnknownServer: async () => {
          await new Promise((resolveWait) => setTimeout(resolveWait, 300));
          pendingAtDecision = server.connections[0]?.pendingWriteBytes() ?? -1;
          return false;
        },
      }),
      dialTimeoutMs: 5_000,
    }),
    (error: TlsTrustError) => {
      assert.equal(error.code, 'TLS_UNTRUSTED');
      return true;
    },
  );

  // The kernel takes a few MiB on its own; a client that read everything would leave nothing here.
  assert.ok(pendingAtDecision >= 4 * MIB, `the server still held ${pendingAtDecision} unread bytes at the decision`);
});

test('a refused connect names the error code, not the errno number', async () => {
  const probe = await startFakeServer({ identity, onFrame: () => undefined });
  const deadPort = probe.port;
  await probe.close();

  await assert.rejects(
    Connection.dial({
      target: { host: '127.0.0.1', port: deadPort, hostIndex: 0 },
      trust: pinned(),
      dialTimeoutMs: 5_000,
    }),
    (error: HoardDBError) => {
      assert.equal(error.code, 'CONNECTION_FAILED');
      // 'ECONNREFUSED' says what happened; '-111' says it only to someone holding errno.h.
      assert.ok(error.message.startsWith(`Could not connect to 127.0.0.1:${deadPort} (ECONNREFUSED).`), error.message);
      return true;
    },
  );
});

test('a server without ALPN is refused as a protocol error', async () => {
  const server = await fakeServer(() => undefined, false);

  await assert.rejects(
    Connection.dial({
      target: { host: '127.0.0.1', port: server.port, hostIndex: 0 },
      trust: pinned(),
      dialTimeoutMs: 5_000,
    }),
    (error: ProtocolError) => {
      assert.equal(error.code, 'PROTOCOL_ERROR');
      assert.match(error.message, /ALPN "false" instead of hoarddb\/1/);
      return true;
    },
  );
  assert.equal(server.totalBytesReceived(), 0);
});

test('send matches the response by request ID', async () => {
  const seen: Uint8Array[] = [];
  const server = await fakeServer((frame, conn) => {
    seen.push(frame.requestId);
    conn.replyDoc(Op.PONG, frame.requestId, { ok: true });
  });
  const connection = await dial(server);

  const answer = await connection.send(Op.PING, new Uint8Array(0), { timeoutMs: 2_000, expect: [Op.PONG] });

  assert.equal(answer.opcode, Op.PONG);
  assert.equal(seen.length, 1);
  assert.deepEqual(answer.requestId, seen[0]);
  assert.equal(decodeDocument(answer.payload, 'safe').ok, true);
  assert.equal(connection.inFlight, 0);
  assert.equal(connection.closed, false);
});

test('a response with an unknown request ID destroys the connection', async () => {
  const server = await fakeServer((_frame, conn) => {
    conn.replyDoc(Op.PONG, newRequestId(), { ok: true });
  });
  const connection = await dial(server);

  const failure = await rejects(
    connection.send(Op.PING, new Uint8Array(0), { timeoutMs: 2_000, expect: [Op.PONG] }),
  );

  assert.ok(failure instanceof ProtocolError);
  assert.match(failure.message, /that is not in flight/);
  assert.equal(connection.closed, true);
});

test('a zero request ID ERROR answers the in-flight request and closes', async () => {
  const server = await fakeServer((_frame, conn) => {
    conn.replyDoc(Op.ERROR, new Uint8Array(16), { code: 1, message: 'no such bucket' });
  });
  const connection = await dial(server);
  const closed = closedBy(connection);

  const answer = await connection.send(Op.GET, new Uint8Array(0), { timeoutMs: 2_000, expect: [Op.GET_RESPONSE] });

  assert.equal(answer.opcode, Op.ERROR);
  assert.equal(decodeDocument(answer.payload, 'safe').message, 'no such bucket');
  await closed;
  assert.equal(connection.closed, true);
});

test('a refusal sent before any request is what the next send throws', async () => {
  const sentence = 'server connection limit reached (1, HOARDDB_TCP_MAX_CONNS_PER_IP); retry shortly or raise the cap (currently 1 connections)';
  const server = await startFakeServer({
    identity,
    onFrame: () => undefined,
    // Over its connection budget the server refuses as soon as the handshake is done, before AUTH.
    onConnect: (conn) => {
      conn.replyDoc(Op.ERROR, new Uint8Array(16), { code: 13, message: sentence });
      conn.end();
    },
  });
  servers.push(server);
  const connection = await dial(server);
  const closed = closedBy(connection);

  const reason = await closed;
  assert.ok(reason instanceof OverloadedError, `closed by ${String(reason)}`);

  const error = await rejects(connection.send(Op.PING, new Uint8Array(0), { timeoutMs: 1_000, expect: [Op.PONG] }));
  assert.ok(error instanceof OverloadedError, `expected OverloadedError, got ${String(error)}`);
  assert.equal(error.message, sentence, "the server's sentence, not a bare connection failure");
  assert.equal(error.wireCode, 13);
});

test('a timeout destroys the socket and rejects RequestTimeoutError', async () => {
  const server = await fakeServer(() => undefined);
  const connection = await dial(server);

  const failure = await rejects(
    connection.send(Op.PING, new Uint8Array(0), { timeoutMs: 50, expect: [Op.PONG] }),
  );

  assert.ok(failure instanceof RequestTimeoutError);
  assert.equal(failure.code, 'REQUEST_TIMEOUT');
  assert.match(failure.message, /timed out after 50 ms/);
  assert.equal(connection.closed, true);
});

test('an abort destroys the socket and rejects AbortedError', async () => {
  const server = await fakeServer(() => undefined);
  const connection = await dial(server);
  const controller = new AbortController();

  const sent = connection.send(Op.PING, new Uint8Array(0), {
    timeoutMs: 5_000,
    signal: controller.signal,
    expect: [Op.PONG],
  });
  setTimeout(() => controller.abort(new Error('the caller gave up')), 20);
  const failure = await rejects(sent);

  assert.ok(failure instanceof AbortedError);
  assert.equal(failure.code, 'ABORTED');
  assert.match(failure.message, /was aborted/);
  assert.equal(connection.closed, true);
});

test('an already-aborted signal sends nothing', async () => {
  let frames = 0;
  const server = await fakeServer(() => {
    frames += 1;
  });
  const connection = await dial(server);
  const controller = new AbortController();
  controller.abort(new Error('aborted before the call'));

  const failure = await rejects(
    connection.send(Op.PING, new Uint8Array(0), {
      timeoutMs: 5_000,
      signal: controller.signal,
      expect: [Op.PONG],
    }),
  );
  await new Promise((resolveWait) => setTimeout(resolveWait, 50));

  assert.ok(failure instanceof AbortedError);
  assert.equal(frames, 0);
  assert.equal(server.totalBytesReceived(), 0);
  assert.equal(connection.closed, false);
});

test('a hostile length is refused before allocation', async () => {
  const server = await fakeServer((_frame, conn) => {
    conn.writeRaw(new Uint8Array([0x01, 0xff, 0xff, 0xff, 0xff]));
  });
  const connection = await dial(server);

  const failure = await rejects(
    connection.send(Op.PING, new Uint8Array(0), { timeoutMs: 2_000, expect: [Op.PONG] }),
  );

  assert.ok(failure instanceof ProtocolError);
  assert.equal(failure.refusal, 'length-too-large');
  assert.match(failure.message, /33554432-byte \(32 MiB\) frame limit/);
  assert.equal(connection.closed, true);
});
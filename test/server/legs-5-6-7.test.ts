// SPDX-License-Identifier: Apache-2.0
//
// Legs 5, 6 and 7 of the conformance harness (handbook testing.md section 2): the same bad requests
// give the same code, class and message; the size limits hold at both edges; a killed server is a
// typed error and never a hang. Servers are started per group or per test, because most of these
// change an operator limit or kill the process.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { connect as connectTls, type TLSSocket } from 'node:tls';

import {
  AlreadyExistsError,
  ConnectionError,
  FieldTypeError,
  FrameTooLargeError,
  HoardDBError,
  InvalidArgumentError,
  NotAuthenticatedError,
  NotFoundError,
  connect,
  type Client,
  type ConnectOptions,
} from '../../src/index.js';
import { authenticate } from '../../src/auth.js';
import { bytesFromExtendedJson, decodeDocument, valuesFromExtendedJson } from '../../src/codec/index.js';
import { Connection } from '../../src/connection.js';
import { errorFromErrorPayload } from '../../src/errors.js';
import { makeTrustPolicy } from '../../src/trust.js';
import { FrameDecoder, type Frame } from '../../src/wire/frame.js';
import { Op } from '../../src/wire/opcodes.js';
import { encodeRequest } from '../../src/wire/messages.js';
import { hexToBytes, vectorNamed } from '../helpers/vectors.js';
import { rewritePorts, startServer, type StartOptions, type TestServer } from '../helpers/server.js';

const TRUST = { knownServersPath: false } as const;
const MIB = 1024 * 1024;

/** A server and a client for one test; both are closed whatever the body does. */
async function withClient(
  options: StartOptions,
  settings: ConnectOptions,
  body: (client: Client, server: TestServer) => Promise<void>,
): Promise<void> {
  const server = await startServer(options);
  let client: Client | undefined;
  try {
    client = await connect(server.uri(), { tls: TRUST, ...settings });
    await body(client, server);
  } finally {
    await client?.close({ timeoutMs: 1_000 });
    await server.stop();
  }
}

async function rejectionOf(call: () => Promise<unknown>): Promise<HoardDBError> {
  try {
    await call();
  } catch (error) {
    assert.ok(error instanceof HoardDBError, `a HoardDBError was thrown (got ${String(error)})`);
    return error;
  }
  throw new Error('the call resolved; it should have been refused');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function pinned(server: TestServer): ReturnType<typeof makeTrustPolicy> {
  return makeTrustPolicy({ fingerprints: [server.fingerprint], knownServersPath: false }, [], 1);
}

async function dialRaw(server: TestServer): Promise<Connection> {
  return Connection.dial({
    target: { host: server.host, port: server.port, hostIndex: 0 },
    trust: pinned(server),
    dialTimeoutMs: 10_000,
  });
}

/** A TLS socket with the protocol negotiated and nothing written: the harness writes the bytes itself. */
function rawSocket(server: TestServer): Promise<TLSSocket> {
  return new Promise((resolveSocket, rejectSocket) => {
    const socket = connectTls({
      host: server.host,
      port: server.port,
      ALPNProtocols: ['hoarddb/1'],
      minVersion: 'TLSv1.3',
      rejectUnauthorized: false,
    });
    socket.once('error', rejectSocket);
    socket.once('secureConnect', () => {
      socket.off('error', rejectSocket);
      resolveSocket(socket);
    });
  });
}

// ---------------------------------------------------------------- leg 5

interface ErrorVector {
  name: string;
  request: { payload_json: Record<string, unknown> };
  response: { payload_json: { message: string } };
  setup?: { payload_json: Record<string, unknown> }[];
  error: { code: number; name: string; write_outcome?: string };
}

function errorVector(name: string): ErrorVector {
  return vectorNamed(name) as unknown as ErrorVector;
}

test("missing bucket, missing database, duplicate database, bucket of another type, unauthenticated request, oversized value and mistyped document each give the vector's code and class and the server's message verbatim", async () => {
  await withClient(
    { env: { HOARDDB_MAX_DOCUMENT_BYTES: '4096', HOARDDB_MAX_BLOB_BYTES: '1024' } },
    {},
    async (client, server) => {
      /** The server's message for the vector, with the vector's database name replaced by this test's. */
      const verbatim = (vector: ErrorVector, vectorDatabase: unknown, mine: string): string =>
        String(vector.response.payload_json.message).replaceAll(String(vectorDatabase), mine);
      const actualMessage = (error: HoardDBError): string =>
        (rewritePorts({ message: error.message }, server) as { message: string }).message;
      // A refused write carries write_outcome not_applied on every vector (the server stamps it on a single node
      // as on a cluster), so the driver adds no unknown-outcome sentence: the message is the server's, verbatim.
      const check = (vector: ErrorVector, error: HoardDBError, expected: string, isWrite = false): void => {
        assert.equal(error.code, vector.error.name, `${vector.name}: code`);
        assert.equal(actualMessage(error), expected, `${vector.name}: message`);
        if (isWrite) {
          assert.equal(vector.error.write_outcome, 'not_applied', `${vector.name}: the vector carries the outcome`);
          assert.equal(error.writeOutcome, 'not_applied', `${vector.name}: writeOutcome`);
        }
      };

      const missingBucket = errorVector('get of a bucket that does not exist');
      await client.createDatabase('l5_nobucket');
      let error = await rejectionOf(() => client.database('l5_nobucket').hash('users').get('ada'));
      assert.ok(error instanceof NotFoundError, `${missingBucket.name}: class`);
      check(missingBucket, error, verbatim(missingBucket, missingBucket.request.payload_json['database'], 'l5_nobucket'));

      const missingDatabase = errorVector('get of a database that does not exist');
      error = await rejectionOf(() => client.database('l5_nodb').hash('users').get('ada'));
      assert.ok(error instanceof NotFoundError, `${missingDatabase.name}: class`);
      check(missingDatabase, error, verbatim(missingDatabase, missingDatabase.request.payload_json['database'], 'l5_nodb'));

      const duplicate = errorVector('create database that exists');
      await client.createDatabase('l5_dup');
      error = await rejectionOf(() => client.createDatabase('l5_dup'));
      assert.ok(error instanceof AlreadyExistsError, `${duplicate.name}: class`);
      check(duplicate, error, verbatim(duplicate, duplicate.request.payload_json['name'], 'l5_dup'));

      const otherType = errorVector('create bucket that exists with another type');
      await client.createDatabase('l5_type');
      await client.database('l5_type').createBucket('b', 'hash');
      error = await rejectionOf(() => client.database('l5_type').createBucket('b', 'btree'));
      assert.ok(error instanceof AlreadyExistsError, `${otherType.name}: class`);
      check(otherType, error, verbatim(otherType, otherType.request.payload_json['database'], 'l5_type'));

      const unauthenticated = errorVector('request before authentication');
      const raw = await dialRaw(server);
      try {
        const frame = await raw.send(Op.GET, bytesFromExtendedJson(unauthenticated.request.payload_json), {
          timeoutMs: 10_000,
          expect: [Op.GET_RESPONSE],
        });
        assert.equal(frame.opcode, Op.ERROR);
        error = errorFromErrorPayload(frame.payload, { operation: 'get' });
        assert.ok(error instanceof NotAuthenticatedError, `${unauthenticated.name}: class`);
        check(unauthenticated, error, String(unauthenticated.response.payload_json.message));
      } finally {
        raw.destroy();
      }

      const oversized = errorVector('a document over the document limit');
      await client.createDatabase('l5_big');
      const docs = await client.database('l5_big').createBucket('docs', 'hash');
      const bigDocument = valuesFromExtendedJson(oversized.request.payload_json['data'], 'safe');
      error = await rejectionOf(() => docs.put(String(oversized.request.payload_json['key']), bigDocument));
      assert.ok(error instanceof InvalidArgumentError, `${oversized.name}: class`);
      check(oversized, error, verbatim(oversized, oversized.request.payload_json['database'], 'l5_big'), true);

      const mistyped = errorVector('a mistyped document on a typed bucket');
      await client.createDatabase('l5_typed');
      const typed = await client.database('l5_typed').createBucket('users', 'hash', {
        fieldTypes: { mode: 'strict', fields: [{ name: 'Born', type: 'int' }] },
      });
      const badDocument = valuesFromExtendedJson(mistyped.request.payload_json['data'], 'safe');
      error = await rejectionOf(() => typed.put(String(mistyped.request.payload_json['key']), badDocument));
      assert.ok(error instanceof FieldTypeError, `${mistyped.name}: class`);
      check(mistyped, error, verbatim(mistyped, mistyped.request.payload_json['database'], 'l5_typed'), true);
    },
  );
});

// ---------------------------------------------------------------- leg 6

test('a document just under and just over 24 MiB', async () => {
  await withClient({}, {}, async (client) => {
    await client.createDatabase('l6_doc');
    const docs = await client.database('l6_doc').createBucket<{ text: string }>('docs', 'hash');
    await docs.put('under', { text: 'x'.repeat(24 * MIB - 1024 - 64) });
    assert.equal((await docs.get('under'))?.text.length, 24 * MIB - 1024 - 64);

    const error = await rejectionOf(() => docs.put('over', { text: 'x'.repeat(24 * MIB + 1024) }));
    assert.ok(error instanceof InvalidArgumentError);
    assert.ok(error.message.startsWith('Document "'), `the server's sentence: ${error.message.slice(0, 80)}`);
  });
});

test('a blob at 16 MiB and just over', async () => {
  await withClient({}, {}, async (client) => {
    await client.createDatabase('l6_blob');
    const blobs = await client.database('l6_blob').createBucket('files', 'blob');
    const fits = Uint8Array.from({ length: 16 * MIB - 1024 }, (_, at) => (at * 31) % 251);
    await blobs.putBlob('fits', fits);
    const stored = await blobs.getBlob('fits');
    assert.ok(stored !== null);
    assert.ok(Buffer.from(stored.data).equals(Buffer.from(fits)), 'the blob came back byte for byte');

    const error = await rejectionOf(() => blobs.putBlob('over', new Uint8Array(16 * MIB + 1024)));
    assert.ok(error instanceof InvalidArgumentError);
    assert.ok(error.message.startsWith('Blob "'), `the server's sentence: ${error.message.slice(0, 80)}`);
  });
});

test('a frame over 32 MiB is refused before sending', async () => {
  await withClient({}, {}, async (client, server) => {
    await client.createDatabase('l6_frame');
    const blobs = await client.database('l6_frame').createBucket('files', 'blob');
    const logBefore = readFileSync(server.logPath, 'utf8');
    const error = await rejectionOf(() => blobs.putBlob('toolarge', new Uint8Array(33 * MIB)));
    assert.ok(error instanceof FrameTooLargeError);
    await sleep(300);
    const gained = readFileSync(server.logPath, 'utf8').slice(logBefore.length);
    assert.ok(!gained.includes('toolarge'), `the server heard of the refused blob: ${gained.slice(0, 200)}`);
    assert.ok(!gained.includes('l6_frame'), `the server heard of the refused blob: ${gained.slice(0, 200)}`);
  });
});

test('the server answers an oversize header by its request ID', async () => {
  const vector = vectorNamed('an oversize request is answered by its request ID');
  const header = hexToBytes(String(vector['request_header_hex']));
  const requestId = header.subarray(6, 22);

  const server = await startServer();
  try {
    const socket = await rawSocket(server);
    try {
      const decoder = new FrameDecoder();
      const frame = await new Promise<Frame>((resolveFrame, rejectFrame) => {
        const timer = setTimeout(() => rejectFrame(new Error('no frame arrived in 10 s')), 10_000);
        socket.on('data', (chunk: Buffer) => {
          decoder.push(chunk);
          const next = decoder.next();
          if (next !== null) {
            clearTimeout(timer);
            resolveFrame(next);
          }
        });
        socket.write(header);
      });
      assert.equal(frame.opcode, Op.ERROR);
      assert.deepEqual(Buffer.from(frame.requestId), Buffer.from(requestId), 'the request ID is echoed');
      const fields = decodeDocument(frame.payload, 'safe');
      assert.ok(String(fields['message']).includes('over the 32 MiB frame limit'), String(fields['message']));
    } finally {
      socket.destroy();
    }
  } finally {
    await server.stop();
  }
});

test('a bad version byte is closed without an answer', async () => {
  const server = await startServer();
  try {
    const socket = await rawSocket(server);
    try {
      let received = 0;
      const closed = new Promise<void>((resolveClosed, rejectClosed) => {
        const timer = setTimeout(() => rejectClosed(new Error('the socket was not closed in 10 s')), 10_000);
        socket.on('data', (chunk: Buffer) => {
          received += chunk.length;
        });
        socket.once('close', () => {
          clearTimeout(timer);
          resolveClosed();
        });
        socket.once('error', () => undefined);
      });
      socket.write(hexToBytes('021100000011766563746f722d69642d763100000003'));
      await closed;
      assert.equal(received, 0, 'no frame came back');
    } finally {
      socket.destroy();
    }
  } finally {
    await server.stop();
  }
});

test('RESULT_TOO_LARGE leaves the same connection answering PING', async () => {
  await withClient({ env: { HOARDDB_QUERY_MAX_RESULT_BYTES: '1048576' } }, {}, async (client, server) => {
    await client.createDatabase('l6_rtl');
    const docs = await client.database('l6_rtl').createBucket<{ text: string }>('docs', 'hash');
    await docs.put('a', { text: 'x'.repeat(700_000) });
    await docs.put('b', { text: 'x'.repeat(700_000) });

    const raw = await dialRaw(server);
    try {
      await authenticate(raw, { username: server.user, password: server.password }, 10_000);
      const scan = await raw.send(
        Op.SCAN,
        encodeRequest('SCAN', { database: 'l6_rtl', bucket: 'docs', limit: 10 }),
        { timeoutMs: 10_000, expect: [Op.SCAN] },
      );
      assert.equal(scan.opcode, Op.ERROR);
      assert.equal(decodeDocument(scan.payload, 'safe')['code'], 14);

      const pong = await raw.send(Op.PING, new Uint8Array(0), { timeoutMs: 10_000, expect: [Op.PONG] });
      assert.equal(pong.opcode, Op.PONG, 'the same connection still answers');
    } finally {
      raw.destroy();
    }
  });
});

test('the per-address cap does not break the pool', async () => {
  await withClient(
    { env: { HOARDDB_TCP_MAX_CONNS_PER_IP: '2' } },
    { pool: { size: 4, bulkSize: 1 } },
    async (client) => {
      await client.createDatabase('l6_cap');
      const users = await client.database('l6_cap').createBucket('users', 'hash');
      await Promise.all(Array.from({ length: 20 }, (_, at) => users.put(`k${at}`, { n: at })));
      const reads = await Promise.all(Array.from({ length: 20 }, (_, at) => users.get(`k${at}`)));
      assert.equal(reads.length, 20);
      assert.ok(client.poolStats().point.open <= 2, `${client.poolStats().point.open} point connections are open`);
    },
  );
});

// ---------------------------------------------------------------- leg 7

test('the server killed mid-request gives ConnectionError without a hang and the driver recovers after a restart', async () => {
  await withClient({}, { requestTimeoutMs: 10_000 }, async (client, server) => {
    await client.createDatabase('l7_kill');
    const users = await client.database('l7_kill').createBucket('users', 'hash');
    await users.put('ada', { n: 1 });

    const started = Date.now();
    const inFlight = rejectionOf(() => users.get('ada'));
    server.kill();
    const error = await inFlight;
    assert.ok(error instanceof ConnectionError, `a ConnectionError, got ${error.name}: ${error.message}`);
    assert.ok(Date.now() - started < 10_000, 'the rejection came within the request timeout');

    await server.restart();
    assert.equal((await users.get('ada'))?.n, 1, 'the next read succeeds after the restart');
  });
});

test('a write killed mid-request is writeOutcome unknown and not resent', async () => {
  await withClient({}, { requestTimeoutMs: 10_000 }, async (client, server) => {
    await client.createDatabase('l7_write');
    const queue = await client.database('l7_write').createBucket<{ text: string }>('q', 'fifo');

    // A large push is still being written when the process dies, so the request has left the driver.
    const inFlight = rejectionOf(() => queue.push({ text: 'x'.repeat(8 * MIB) }));
    await new Promise((resolveTick) => setImmediate(resolveTick));
    server.kill();
    const error = await inFlight;
    assert.ok(error instanceof ConnectionError, `a ConnectionError, got ${error.name}: ${error.message}`);
    assert.equal(error.writeOutcome, 'unknown');

    await server.restart();
    const stored = await queue.count();
    assert.ok(stored === 0 || stored === 1, `the push was stored at most once (count ${stored})`);
  });
});

test('an idle connection the server closed is replaced, not used', async () => {
  await withClient({ env: { HOARDDB_TCP_IDLE_TIMEOUT: '2' } }, {}, async (client) => {
    await client.createDatabase('l7_idle');
    const users = await client.database('l7_idle').createBucket('users', 'hash');
    await assert.rejects(users.get('ada'), NotFoundError);

    await sleep(3_000);
    await assert.rejects(users.get('ada'), NotFoundError, 'the next call succeeds (a typed miss, not a connection error)');
    assert.equal(client.poolStats().retries, 0, 'on a replaced connection, not a retried one');
  });
});

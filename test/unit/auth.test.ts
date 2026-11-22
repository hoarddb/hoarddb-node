// SPDX-License-Identifier: Apache-2.0
//
// AUTH and the token session, against the in-process fake server. Three orders fail silently if
// they break, so they are proven here: the frame carries exactly the vector's fields, a token
// replaces the password rather than joining it, and a refused password AUTH spends the connection
// (handbook auth.md sections 1 to 3).

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { inspect } from 'node:util';

import { Session, authenticate } from '../../src/auth.js';
import { decodeDocument, extendedJsonFromBytes } from '../../src/codec/index.js';
import { Connection } from '../../src/connection.js';
import { AuthenticationError, ConfigError, InternalError } from '../../src/errors.js';
import { makeTrustPolicy } from '../../src/trust.js';
import { DRIVER_VERSION } from '../../src/version.js';
import type { Frame } from '../../src/wire/frame.js';
import { Op } from '../../src/wire/opcodes.js';
import { assertRequestMatches } from '../helpers/compare.js';
import { authOkDoc, startFakeServer, type FakeConnection, type FakeServer } from '../helpers/fake-server.js';
import { makeTlsIdentity, removeTlsIdentity, type TlsIdentity } from '../helpers/tls-identity.js';
import { vectorNamed } from '../helpers/vectors.js';

/** A password a test can look for in every message the driver produced. */
const PASSWORD = 'pw-SECRET-1';

interface Captured {
  /** The request as the driver decoded it, for exact field values. */
  fields: Record<string, unknown>;
  /** The request as canonical Extended JSON, which is what a vector is written in. */
  ejson: Record<string, unknown>;
}

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

/** Dial one fake server that records the AUTH frame it is given and answers it. */
async function withAuth<T>(
  answer: (conn: FakeConnection, frame: Frame) => void,
  body: (connection: Connection) => Promise<T>,
): Promise<{ captured: Captured; result: T }> {
  const captured: Captured = { fields: {}, ejson: {} };
  const server = await startFakeServer({
    identity,
    onFrame: (frame, conn) => {
      captured.fields = decodeDocument(frame.payload, 'safe');
      captured.ejson = extendedJsonFromBytes(frame.payload);
      answer(conn, frame);
    },
  });
  servers.push(server);

  const connection = await Connection.dial({
    target: { host: '127.0.0.1', port: server.port, hostIndex: 0 },
    trust: makeTrustPolicy({ fingerprints: [identity.fingerprint], knownServersPath: false }, [], 1),
    dialTimeoutMs: 5_000,
  });
  connections.push(connection);

  return { captured, result: await body(connection) };
}

const acceptLogin = (conn: FakeConnection, frame: Frame): void => {
  conn.replyDoc(Op.AUTH_OK, frame.requestId, authOkDoc());
};

test("the AUTH request matches the auth vector's shape", async () => {
  const vector = vectorNamed('auth with a password');
  const request = vector['request'] as { payload_json: Record<string, unknown>; allowed_fields: string[] };
  const expected = { ...request.payload_json };
  // The vector records the string the capture harness used; ours names this driver instead.
  delete expected['client'];

  const { captured } = await withAuth(acceptLogin, async (connection) => {
    await authenticate(connection, { username: 'admin', password: 'vectors-root-password' }, 2_000);
  });

  assertRequestMatches(captured.ejson, expected, request.allowed_fields);
  // The client string is the driver's own, and the program may append its name to it.
  assert.equal(captured.fields['client'], `hoarddb-node/${DRIVER_VERSION}`);
  assert.equal(captured.fields['username'], 'admin');
});

test('capabilities is an empty array', async () => {
  const { captured } = await withAuth(acceptLogin, async (connection) => {
    await authenticate(connection, { username: 'admin', password: PASSWORD }, 2_000);
  });

  assert.deepEqual(captured.fields['capabilities'], []);
});

test('AUTH_OK fills serverVersion, capabilities and the token', async () => {
  const { result } = await withAuth(acceptLogin, (connection) =>
    authenticate(connection, { username: 'admin', password: PASSWORD }, 2_000),
  );

  assert.equal(result.serverVersion, 'fake');
  assert.equal(result.protocolVersion, 1);
  assert.ok(result.capabilities.includes('auth_token'));
  assert.equal(result.token, 'tok-1');
  assert.equal(typeof result.tokenExpiresAt, 'number');
  assert.equal(typeof result.tokenDeadline, 'number');
  assert.equal(result.passwordMinLength, 12);
});

test('AUTH_FAIL CREDENTIALS rejects and destroys the connection', async () => {
  let dialed: Connection | undefined;

  await assert.rejects(
    withAuth(
      (conn, frame) => {
        conn.replyDoc(Op.AUTH_FAIL, frame.requestId, { reason: 1, message: 'invalid credentials' });
      },
      async (connection) => {
        dialed = connection;
        await authenticate(connection, { username: 'admin', password: PASSWORD }, 2_000);
      },
    ),
    (error: AuthenticationError) => {
      assert.ok(error instanceof AuthenticationError);
      assert.equal(error.code, 'AUTH_FAILED');
      assert.equal(error.reason, 'CREDENTIALS');
      assert.match(error.message, /Authentication failed for user/);
      assert.match(error.message, /does not retry/);
      assert.match(error.message, /Server said: "invalid credentials"\./);
      return true;
    },
  );

  // The claim is taken before the password is checked, so this socket can never authenticate again.
  assert.equal(dialed?.closed, true);
});

test('AUTH_FAIL CREDENTIALS names the user it refused', async () => {
  let address = '';

  await assert.rejects(
    withAuth(
      (conn, frame) => {
        conn.replyDoc(Op.AUTH_FAIL, frame.requestId, { reason: 1, message: 'invalid credentials' });
      },
      async (connection) => {
        address = connection.address;
        await authenticate(connection, { username: 'ada', password: PASSWORD }, 2_000);
      },
    ),
    (error: AuthenticationError) => {
      assert.equal(error.reason, 'CREDENTIALS');
      // Handbook errors.md section 7: the sentence names the user, never the password.
      assert.ok(
        error.message.startsWith(`Authentication failed for user "ada" on ${address}. Check the user name and password`),
        error.message,
      );
      assert.equal(error.message.includes(PASSWORD), false);
      return true;
    },
  );
});

test('an ERROR answering AUTH is a typed refusal and spends the connection', async () => {
  let dialed: Connection | undefined;

  await assert.rejects(
    withAuth(
      (conn, frame) => {
        // The server answers AUTH with ERROR INTERNAL and its own request ID when its auth handler
        // fails (transport/serve.go serveAuthFrame), and keeps the socket open.
        conn.replyDoc(Op.ERROR, frame.requestId, { code: 0x05, message: 'the auth handler failed' });
      },
      async (connection) => {
        dialed = connection;
        await authenticate(connection, { username: 'admin', password: PASSWORD }, 2_000);
      },
    ),
    (error: InternalError) => {
      // Handbook errors.md section 1: an ERROR frame is never success.
      assert.ok(error instanceof InternalError, `expected InternalError, got ${String(error)}`);
      assert.equal(error.code, 'INTERNAL');
      assert.equal(error.wireCode, 5);
      assert.equal(error.message, 'the auth handler failed');
      assert.equal(error.operation, 'auth');
      return true;
    },
  );

  assert.equal(dialed?.closed, true, 'a connection whose AUTH was refused is never handed out');
});

test('a token is presented with an empty password', async () => {
  const session = new Session({ username: 'admin', password: PASSWORD }, Date.now);
  session.record({
    serverVersion: 'fake',
    protocolVersion: 1,
    capabilities: ['auth_token'],
    token: 'tok-1',
    tokenExpiresAt: Math.floor(Date.now() / 1000) + 900,
    tokenDeadline: Math.floor(Date.now() / 1000) + 43_200,
  });

  const credential = session.credentialForNewConnection();
  assert.deepEqual(credential, { token: 'tok-1' });

  const { captured } = await withAuth(acceptLogin, async (connection) => {
    await authenticate(connection, { username: 'admin', ...credential }, 2_000);
  });

  assert.equal(captured.fields['token'], 'tok-1');
  assert.equal(captured.fields['password'], '');
});

test('the token is dropped when auth_token is not advertised', () => {
  const session = new Session({ username: 'admin', password: PASSWORD }, Date.now);

  session.record({
    serverVersion: 'fake',
    protocolVersion: 1,
    capabilities: ['write_concern', 'consistent_get'],
    token: 'tok-1',
    tokenExpiresAt: Math.floor(Date.now() / 1000) + 900,
    tokenDeadline: Math.floor(Date.now() / 1000) + 43_200,
  });

  assert.deepEqual(session.credentialForNewConnection(), { password: PASSWORD });
  assert.equal(session.needsRefresh(), false);

  session.dropToken();
  assert.deepEqual(session.credentialForNewConnection(), { password: PASSWORD });
});

test('needsRefresh turns true at half the lifetime', () => {
  let now = 1_000_000;
  const session = new Session({ username: 'admin', password: PASSWORD }, () => now);
  // Issued at 1_000_000 ms, expiring at 1_900_000 ms: the halfway point is 1_450_000.
  session.record({
    serverVersion: 'fake',
    protocolVersion: 1,
    capabilities: ['auth_token'],
    token: 'tok-1',
    tokenExpiresAt: 1_900,
    tokenDeadline: 45_000,
  });

  now = 1_449_999;
  assert.equal(session.needsRefresh(), false);

  now = 1_450_000;
  assert.equal(session.needsRefresh(), true);

  // One refresh at a time: a client that is already refreshing does not stampede.
  session.refreshing = true;
  assert.equal(session.needsRefresh(), false);
});

test('pastDeadline turns true at the deadline', () => {
  let now = 999_999;
  const session = new Session({ username: 'admin', password: PASSWORD }, () => now);
  session.record({
    serverVersion: 'fake',
    protocolVersion: 1,
    capabilities: ['auth_token'],
    token: 'tok-1',
    tokenExpiresAt: 1_900,
    tokenDeadline: 1_000,
  });

  assert.equal(session.pastDeadline(), false);

  now = 1_000_000;
  assert.equal(session.pastDeadline(), true);
});

test("a session fed the fake server's AUTH_OK refreshes at half of 900 s", async () => {
  const issued = Date.now();
  let now = issued;
  const session = new Session({ username: 'admin', password: PASSWORD }, () => now);

  const { result } = await withAuth(acceptLogin, (connection) =>
    authenticate(connection, { username: 'admin', password: PASSWORD }, 2_000),
  );
  session.record(result);

  // The server stamps both times in Unix seconds (the server's AuthResponse), and so
  // must the fake, or every test built on it exercises a token that never comes due.
  const expiresAt = result.tokenExpiresAt ?? 0;
  assert.ok(Math.abs(expiresAt - (Math.floor(issued / 1000) + 900)) <= 2, `token_expires_at ${expiresAt} is not now + 900 s`);

  now = issued + 440_000;
  assert.equal(session.needsRefresh(), false, 'not due before half of the 900 s lifetime');
  now = issued + 460_000;
  assert.equal(session.needsRefresh(), true, 'due after half of the 900 s lifetime');
  assert.equal(session.pastDeadline(), false);
  now = issued + 43_202_000;
  assert.equal(session.pastDeadline(), true, 'the refresh chain ends 12 hours after issue');
});

test('the error message never contains the password', async () => {
  let message = '';
  let serialized = '';

  const refused = withAuth(
    (conn, frame) => {
      conn.replyDoc(Op.AUTH_FAIL, frame.requestId, { reason: 1, message: 'invalid credentials' });
    },
    (connection) => authenticate(connection, { username: 'admin', password: PASSWORD }, 2_000),
  );
  await refused.then(
    () => assert.fail('the AUTH_FAIL was answered with a result instead of a refusal'),
    (error: AuthenticationError) => {
      assert.ok(error instanceof AuthenticationError);
      message = error.message;
      serialized = JSON.stringify(error.toJSON());
    },
  );

  assert.equal(message.includes(PASSWORD), false);
  assert.equal(serialized.includes(PASSWORD), false);

  // The other text a caller can hit on this path: no credential at all, which names every way to
  // supply one and none of them is a secret.
  const anonymous = new Session({ username: 'admin' }, Date.now);
  assert.throws(
    () => anonymous.credentialForNewConnection(),
    (error: ConfigError) => {
      assert.ok(error instanceof ConfigError);
      assert.equal(error.code, 'INVALID_OPTIONS');
      assert.equal(
        error.message,
        'No password for user "admin": put it in the URI (hoarddb://admin:<password>@host), pass { password }, or set HOARDDB_ROOT_PASSWORD.',
      );
      return true;
    },
  );
});


test('a session shows neither its password nor its token', () => {
  const session = new Session({ username: 'admin', password: PASSWORD, token: 'tok-SECRET-8' }, Date.now);
  const texts = [inspect(session, { depth: Infinity, showHidden: true }), JSON.stringify(session), String(session)];
  for (const text of texts) {
    assert.equal(text.includes(PASSWORD), false, `the password shows: ${text}`);
    assert.equal(text.includes('tok-SECRET-8'), false, `the token shows: ${text}`);
  }
  // The credentials still work: redaction is for display only.
  assert.deepEqual(session.credentialForNewConnection(), { token: 'tok-SECRET-8' });
});

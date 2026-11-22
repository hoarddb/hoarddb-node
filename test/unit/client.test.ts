// SPDX-License-Identifier: Apache-2.0
//
// The client and its handles: what connect() does against the fake server, what the URI, the options
// and the environment decide, what a refusal says, and what a handle costs (rule 11: a handle does no
// I/O and stays small).

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { format, inspect } from 'node:util';
import v8 from 'node:v8';
import vm from 'node:vm';

import { connect } from '../../src/client.js';
import { encodeDocument } from '../../src/codec/index.js';
import { AuthenticationError, ClientClosedError, ConfigError } from '../../src/errors.js';
import { resolveOptions } from '../../src/options.js';
import type { Client, ConnectOptions, FieldStore } from '../../src/types.js';
import { Op } from '../../src/wire/opcodes.js';
import { recordingClient } from '../helpers/recording.js';
import { authOkDoc, startFakeServer, type FakeServer } from '../helpers/fake-server.js';
import { makeTlsIdentity, removeTlsIdentity, type TlsIdentity } from '../helpers/tls-identity.js';

const PASSWORD = 'pw-SECRET-1';

let identity: TlsIdentity;
const servers: FakeServer[] = [];

before(() => {
  identity = makeTlsIdentity();
});

after(async () => {
  for (const server of servers) await server.close();
  removeTlsIdentity(identity);
});

/** A server that logs every login in, or refuses every login with a credentials failure. */
async function startServer(acceptLogins: boolean): Promise<FakeServer> {
  const server = await startFakeServer({
    identity,
    onFrame: (frame, conn) => {
      if (frame.opcode !== Op.AUTH) return;
      if (acceptLogins) conn.replyDoc(Op.AUTH_OK, frame.requestId, authOkDoc());
      else conn.reply(Op.AUTH_FAIL, frame.requestId, encodeDocument({ reason: 1, message: '' }));
    },
  });
  servers.push(server);
  return server;
}

function uriFor(server: FakeServer, password = PASSWORD): string {
  return `hoarddb://admin:${password}@127.0.0.1:${server.port}`;
}

function pinned(): ConnectOptions['tls'] {
  return { fingerprints: [identity.fingerprint], knownServersPath: false };
}

test('connect against the fake server records serverInfo', async () => {
  const server = await startServer(true);
  const client = await connect(uriFor(server), { tls: pinned() });
  try {
    const info = client.serverInfo();
    assert.equal(info.version, 'fake');
    assert.equal(info.protocolVersion, 1);
    assert.equal(info.passwordMinLength, 12);
    assert.ok(info.capabilities.has('write_concern'), 'the server advertised write_concern');
  } finally {
    await client.close();
  }
});

test('options override the URI and the URI overrides the environment', () => {
  const resolved = resolveOptions(
    'hoarddb://uri-user:uri-pw@uri-host:7001/app',
    { username: 'option-user', database: 'option-db' },
    { HOARDDB_ROOT_USER: 'env-user', HOARDDB_ROOT_PASSWORD: 'env-pw', HOARDDB_URI: 'hoarddb://env-host:7002' },
  );
  assert.equal(resolved.username, 'option-user', 'an option beats the URI');
  assert.equal(resolved.database, 'option-db', 'an option beats the URI database');
  assert.equal(resolved.password, 'uri-pw', 'the URI beats the environment');
  assert.deepEqual(
    resolved.hosts.map((host) => [host.host, host.port]),
    [['uri-host', 7001]],
    'the URI host beats HOARDDB_URI',
  );

  const fromEnvironment = resolveOptions(undefined, undefined, {
    HOARDDB_URI: 'hoarddb://env-host:7002',
    HOARDDB_ROOT_USER: 'env-user',
    HOARDDB_ROOT_PASSWORD: 'env-pw',
  });
  assert.equal(fromEnvironment.hosts[0]?.host, 'env-host');
  assert.equal(fromEnvironment.username, 'env-user');
  assert.equal(fromEnvironment.password, 'env-pw');
});

test('an unknown option is a ConfigError naming the accepted set', () => {
  assert.throws(
    () => resolveOptions(undefined, { bogus: 1 } as unknown as ConnectOptions, {}),
    (error: unknown) =>
      error instanceof ConfigError &&
      error.code === 'INVALID_OPTIONS' &&
      error.message ===
        'Unknown option "bogus" in ConnectOptions; the accepted options are authToken, bucket, clientName, ' +
          'database, dialTimeoutMs, hosts, int64, logger, password, pool, requestTimeoutMs, tls, username, writeConcern.',
  );
});

test('insecure without a reason is a ConfigError', () => {
  assert.throws(
    () => resolveOptions(undefined, { tls: { insecure: { reason: '' } } }, {}),
    (error: unknown) =>
      error instanceof ConfigError &&
      error.message ===
        "tls.insecure needs a reason, for example { insecure: { reason: 'local test server' } }; it is logged on every connection.",
  );
});

test('the password never appears in inspect, JSON or any error of connect', async () => {
  const server = await startServer(false);
  const options: ConnectOptions = { tls: pinned() };
  const resolved = resolveOptions(uriFor(server), options, {});
  const texts: string[] = [inspect(resolved), JSON.stringify(resolved)];

  let caught: unknown;
  try {
    await connect(uriFor(server), options);
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof AuthenticationError, 'a refused login is an AuthenticationError');
  texts.push(String(caught), caught.stack ?? '', JSON.stringify(caught), inspect(caught));

  for (const text of texts) {
    assert.ok(!text.includes(PASSWORD), `the password appears in: ${text}`);
  }
});

test('no password or token is reachable from any public object at any depth', async () => {
  const token = 'tok-SECRET-7';
  const server = await startFakeServer({
    identity,
    onFrame: (frame, conn) => {
      if (frame.opcode === Op.AUTH) conn.replyDoc(Op.AUTH_OK, frame.requestId, authOkDoc({ token }));
    },
  });
  servers.push(server);
  const client = await connect(uriFor(server), { tls: pinned() });
  try {
    const db = client.database('app');
    const users = db.hash('users');
    const purchases = users.field('ada', 'Purchases');
    const publicObjects: Record<string, unknown> = {
      client,
      database: db,
      hash: users,
      btree: db.btree('b'),
      fifo: db.fifo('q'),
      lifo: db.lifo('s'),
      heap: db.heap('h'),
      blob: db.blob('files'),
      bucket: db.bucket('any'),
      fieldStore: purchases,
      nestedFieldStore: purchases.field('order-1', 'Lines'),
      cursor: users.find({}),
    };
    try {
      client.database('');
      client.defaultBucket();
    } catch (error) {
      publicObjects['error'] = error;
    }

    // console.log uses util.inspect; showHidden and an unlimited depth reach everything inspect can.
    for (const [name, value] of Object.entries(publicObjects)) {
      const texts = [inspect(value, { depth: Infinity, showHidden: true }), JSON.stringify(value) ?? ''];
      for (const text of texts) {
        assert.equal(text.includes(PASSWORD), false, `${name} shows the password: ${text.slice(0, 400)}`);
        assert.equal(text.includes(token), false, `${name} shows the resumption token: ${text.slice(0, 400)}`);
      }
    }
  } finally {
    await client.close();
  }
});

test('createDatabase with ifNotExists does not count the ALREADY_EXISTS it swallowed', async () => {
  const server = await startFakeServer({
    identity,
    onFrame: (frame, conn) => {
      if (frame.opcode === Op.AUTH) conn.replyDoc(Op.AUTH_OK, frame.requestId, authOkDoc());
      else if (frame.opcode === Op.CREATE_DB) {
        conn.replyDoc(Op.ERROR, frame.requestId, { code: 2, message: 'database "app" already exists' });
      }
    },
  });
  servers.push(server);
  const client = await connect(uriFor(server), { tls: pinned() });
  try {
    await client.createDatabase('app', { ifNotExists: true });
    assert.deepEqual(client.poolStats().errors, {}, 'a refusal the caller asked to be spared is not counted');
    await assert.rejects(client.createDatabase('app'), (error: Error & { code?: string }) => error.code === 'ALREADY_EXISTS');
    assert.deepEqual(client.poolStats().errors, { ALREADY_EXISTS: 1 });
  } finally {
    await client.close();
  }
});

test('database() without a default is a ConfigError naming the fix', () => {
  const { client } = recordingClient(new Map(), 'hoarddb://admin@localhost:7433');
  assert.throws(
    () => client.database(),
    (error: unknown) =>
      error instanceof ConfigError &&
      error.message ===
        'No database given and none in the connection string; pass a name, or add /<database> to the URI.',
  );
});

test('defaultDatabase() is the database the URI names, with no I/O', async () => {
  const { client, sent } = recordingClient(new Map(), 'hoarddb://admin@localhost:7433/app/users');
  const database = client.defaultDatabase();
  assert.equal(database.name, 'app');
  // The recording client records after an await, so let every queued step run before looking.
  for (let turn = 0; turn < 5; turn += 1) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sent.length, 0, 'defaultDatabase sent a request');
});

test('defaultDatabase() prefers the database option over the URI path', () => {
  const { client } = recordingClient(new Map(), 'hoarddb://admin@localhost:7433/from-uri', undefined, {
    database: 'from-option',
  });
  assert.equal(client.defaultDatabase().name, 'from-option');
});

test('defaultDatabase() without a database in the URI is a ConfigError naming the fix', () => {
  const { client } = recordingClient(new Map(), 'hoarddb://admin@localhost:7433');
  assert.throws(
    () => client.defaultDatabase(),
    (error: unknown) =>
      error instanceof ConfigError &&
      error.code === 'INVALID_OPTIONS' &&
      error.operation === 'defaultDatabase' &&
      error.message ===
        'No database given and none in the connection string; add it as the path, hoarddb://host/<database>, or use client.database(name).',
  );
});

test('a million handles do no I/O and stay under 150 bytes each', () => {
  v8.setFlagsFromString('--expose-gc');
  const gc = vm.runInNewContext('gc') as () => void;
  const { client, sent } = recordingClient(new Map());
  const db = client.database('app');

  gc();
  const heapBefore = process.memoryUsage().heapUsed;
  const handles: unknown[] = [];
  for (let index = 0; index < 1_000_000; index += 1) handles.push(db.hash('b' + index));
  gc();
  const heapAfter = process.memoryUsage().heapUsed;

  const perHandle = (heapAfter - heapBefore) / 1_000_000;
  process.stdout.write(`handle cost: ${Math.round(perHandle)} bytes\n`);
  assert.equal(handles.length, 1_000_000);
  // 150 bytes: a handle is a client reference and three strings (measured 98 with its name string);
  // a per-handle Promise (+87) or Map (+224) would cross it (build doc section 6).
  assert.ok(perHandle < 150, `a handle costs ${perHandle} bytes`);
  assert.equal(sent.length, 0, 'creating handles sent a request');
});

test('close is idempotent and later calls are ClientClosedError', async () => {
  const { client } = recordingClient(new Map());
  await client.close();
  await client.close();
  await assert.rejects(client.ping(), ClientClosedError);
  await assert.rejects(client.database('app').createBucket('b', 'hash'), ClientClosedError);
});

test('await using closes the client', async () => {
  const server = await startServer(true);
  let seen: Client | undefined;
  {
    await using client = await connect(uriFor(server), { tls: pinned() });
    seen = client;
    assert.equal(client.poolStats().point.open, 1, 'connect opened one point connection');
  }
  assert.equal(seen?.poolStats().point.open, 0, 'the client closed its connections');
});

test('FieldStore keeps the field() accessor and names its own field fieldName', () => {
  // Section 3.5 once declared both a property `field` and a method `field(element, field)`, which
  // TypeScript rejects. The method stays (a store nested in an element); the property is fieldName.
  // Both checks are made by the compiler: a FieldStore without either does not build.
  type HasFieldName = FieldStore extends { readonly fieldName: string } ? true : false;
  type HasAccessor = FieldStore['field'] extends (element: string, field: string) => FieldStore ? true : false;
  const checks: [HasFieldName, HasAccessor] = [true, true];
  assert.deepEqual(checks, [true, true]);
});

test('resolved options keep the password out of every way a program can print them', () => {
  const resolved = resolveOptions(`hoarddb://alice:${PASSWORD}@127.0.0.1:1/app`, { tls: pinned() }, {});
  const texts = [
    inspect(resolved, { depth: null, showHidden: true }),
    inspect(resolved, { depth: Infinity, showHidden: false, getters: true }),
    String(resolved),
    `${JSON.stringify(resolved)}`,
    JSON.stringify({ nested: resolved }),
    format('%s %o %O %j %d', resolved, resolved, resolved, resolved, resolved),
  ];
  for (const text of texts) {
    assert.ok(!text.includes(PASSWORD), `the password appears in: ${text}`);
  }
});

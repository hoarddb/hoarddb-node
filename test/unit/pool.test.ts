// SPDX-License-Identifier: Apache-2.0
//
// The pool, against the in-process fake server. What the pool has to get right cannot be seen in a
// call's result: sockets must open lazily and stay under the lane's ceiling, waiters must be served
// in order and refused rather than queued without bound, a host that is down must fall through to
// the next one but an untrusted key must not, and the heartbeat must ping an idle connection, refresh
// the token once however many connections are due, and close a socket rather than half-close it
// (handbook wire.md sections 7 to 9; auth.md section 3).

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { TLSSocket } from 'node:tls';

import { Session } from '../../src/auth.js';
import { decodeDocument } from '../../src/codec/index.js';
import type { Connection, DialTarget } from '../../src/connection.js';
import { ClientClosedError, OverloadedError, PoolTimeoutError, TlsTrustError } from '../../src/errors.js';
import { Pool, type Lease, type PoolConfig } from '../../src/pool.js';
import { makeTrustPolicy, type TrustPolicy } from '../../src/trust.js';
import type { Frame } from '../../src/wire/frame.js';
import { Op } from '../../src/wire/opcodes.js';
import { authOkDoc, startFakeServer, type FakeConnection, type FakeServer } from '../helpers/fake-server.js';
import { makeTlsIdentity, removeTlsIdentity, type TlsIdentity } from '../helpers/tls-identity.js';

const PASSWORD = 'pw-SECRET-1';
/** The pool's defaults as the build doc gives them (D-25), so a test only names what it varies. */
const BASE_CONFIG: PoolConfig = {
  size: 4,
  bulkSize: 2,
  maxWaiters: 1000,
  idleTimeoutMs: 120_000,
  pingIntervalMs: 60_000,
  heartbeatMs: 5_000,
};

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

/** An AUTH_OK document with the token stamps the server actually sends (Unix seconds, from the helper). */
function authOk(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return authOkDoc(extra);
}

/** The frames a real server answers: a login succeeds, a liveness probe is a PONG. */
function serve(frame: Frame, conn: FakeConnection): void {
  if (frame.opcode === Op.AUTH) conn.replyDoc(Op.AUTH_OK, frame.requestId, authOk());
  else if (frame.opcode === Op.PING) conn.reply(Op.PONG, frame.requestId, new Uint8Array(0));
}

async function fakeServer(
  onFrame: (frame: Frame, conn: FakeConnection) => void = serve,
  onConnect?: (conn: FakeConnection) => void,
): Promise<FakeServer> {
  const server = await startFakeServer(onConnect === undefined ? { identity, onFrame } : { identity, onFrame, onConnect });
  servers.push(server);
  return server;
}

interface PoolOptions {
  config?: Partial<PoolConfig>;
  hosts?: DialTarget[];
  trust?: TrustPolicy;
  now?: () => number;
  random?: () => number;
}

function makePool(server: FakeServer, options: PoolOptions = {}): Pool {
  const now = options.now ?? Date.now;
  const pool = new Pool({
    hosts: options.hosts ?? [{ host: '127.0.0.1', port: server.port, hostIndex: 0 }],
    trust: options.trust ?? makeTrustPolicy({ fingerprints: [identity.fingerprint], knownServersPath: false }, [], 1),
    dialTimeoutMs: 5_000,
    session: new Session({ username: 'admin', password: PASSWORD }, now),
    clientName: 'pool-test',
    config: { ...BASE_CONFIG, ...options.config },
    now,
    random: options.random ?? (() => 0),
    onAuth: () => undefined,
  });
  pools.push(pool);
  return pool;
}

const soon = (): number => Date.now() + 5_000;

const sleep = (ms: number): Promise<void> => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));

/** Wait for a state a fake server or the pool reaches on its own, rather than guessing a delay. */
async function waitFor(what: string, reached: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!reached()) {
    if (Date.now() > deadline) throw new Error(`gave up waiting for ${what}`);
    await sleep(5);
  }
}

function connectionAt(server: FakeServer, index: number): FakeConnection {
  const connection = server.connections[index];
  assert.ok(connection !== undefined, `the fake server has no connection ${index}`);
  return connection;
}

/** The pool hands out connections, not sockets, so a test that watches the socket reads the field. */
function socketOf(connection: Connection): TLSSocket {
  return (connection as unknown as { socket: TLSSocket }).socket;
}

function activeTimeouts(): number {
  return process.getActiveResourcesInfo().filter((resource) => resource === 'Timeout').length;
}

test('sockets open lazily: 100 sequential acquires use one connection', async () => {
  const server = await fakeServer();
  const pool = makePool(server);

  for (let round = 0; round < 100; round += 1) {
    const lease = await pool.acquire('point', soon());
    lease.release();
  }

  assert.equal(server.connections.length, 1);
  assert.equal(pool.dialCount, 1);
  assert.deepEqual(pool.stats().point, { open: 1, inUse: 0, waiting: 0 });
  assert.equal(pool.session.passwordAuths, 1);
});

test('concurrent acquires never exceed size', async () => {
  const server = await fakeServer();
  const pool = makePool(server);

  const held = await Promise.all(Array.from({ length: BASE_CONFIG.size }, () => pool.acquire('point', soon())));
  let servedCount = 0;
  const served: Lease[] = [];
  const waiting = Array.from({ length: 50 - BASE_CONFIG.size }, () =>
    pool
      .acquire('point', Date.now() + 20_000)
      .then((lease) => {
        served.push(lease);
        servedCount += 1;
        return lease;
      }),
  );

  // 46 callers are waiting, and no more sockets were opened for them: the lane is at its size.
  assert.ok(server.connections.length <= BASE_CONFIG.size, `the fake saw ${server.connections.length} connections`);
  assert.deepEqual(pool.stats().point, {
    open: BASE_CONFIG.size,
    inUse: BASE_CONFIG.size,
    waiting: 50 - BASE_CONFIG.size,
  });

  // Every released slot goes to the next waiter, and a waiter that is done hands its own on.
  for (const lease of held) lease.release();
  while (servedCount < 50 - BASE_CONFIG.size) {
    await sleep(0);
    for (const lease of served.splice(0)) lease.release();
  }
  await Promise.all(waiting);

  assert.deepEqual(pool.stats().point, { open: BASE_CONFIG.size, inUse: served.length, waiting: 0 });
  // The sockets stay: a released connection is reused, not thrown away.
  assert.equal(server.connections.length, BASE_CONFIG.size);
  for (const lease of served) lease.release();
});

test('the bulk lane is separate', async () => {
  const server = await fakeServer();
  const pool = makePool(server);

  const held = await Promise.all(
    Array.from({ length: BASE_CONFIG.size }, () => pool.acquire('point', soon())),
  );
  const bulk = await pool.acquire('bulk', soon());

  assert.equal(pool.stats().point.inUse, BASE_CONFIG.size);
  assert.equal(pool.stats().bulk.inUse, 1);
  assert.equal(server.connections.length, BASE_CONFIG.size + 1);
  assert.notEqual(bulk.connection, held[0]?.connection);

  bulk.release();
  for (const lease of held) lease.release();
});

test('waiters are served in order', async () => {
  const server = await fakeServer();
  const pool = makePool(server);

  const held = await Promise.all(
    Array.from({ length: BASE_CONFIG.size }, () => pool.acquire('point', soon())),
  );
  const order: number[] = [];
  const waiting = [0, 1, 2, 3].map((rank) =>
    pool.acquire('point', soon()).then((lease) => {
      order.push(rank);
      return lease;
    }),
  );

  assert.equal(pool.stats().point.waiting, 4);
  for (const lease of held) {
    lease.release();
    await sleep(0);
  }

  assert.deepEqual(order, [0, 1, 2, 3]);
  for (const lease of await Promise.all(waiting)) lease.release();
});

test('a full waiter queue refuses at once', async () => {
  const server = await fakeServer();
  const pool = makePool(server, { config: { maxWaiters: 2 } });

  const held = await Promise.all(
    Array.from({ length: BASE_CONFIG.size }, () => pool.acquire('point', soon())),
  );
  const waiting = [pool.acquire('point', soon()), pool.acquire('point', soon())];

  await assert.rejects(
    pool.acquire('point', soon()),
    (error: PoolTimeoutError) => {
      assert.ok(error instanceof PoolTimeoutError);
      assert.equal(error.code, 'POOL_TIMEOUT');
      assert.equal(
        error.message,
        '2 calls are already waiting for a connection on the point lane; refusing this one instead of queueing without bound.',
      );
      return true;
    },
  );

  for (const lease of held) lease.release();
  for (const lease of await Promise.all(waiting)) lease.release();
});

test('a deadline while waiting is PoolTimeoutError', async () => {
  const server = await fakeServer();
  const pool = makePool(server);

  const held = await Promise.all(
    Array.from({ length: BASE_CONFIG.size }, () => pool.acquire('point', soon())),
  );

  await assert.rejects(
    pool.acquire('point', Date.now() + 100),
    (error: PoolTimeoutError) => {
      assert.ok(error instanceof PoolTimeoutError);
      assert.equal(
        error.message,
        'No connection became free within 100 ms (4 in use, 1 waiting on the point lane). Raise pool.size or pool.bulkSize, or find the call that holds a connection.',
      );
      return true;
    },
  );

  for (const lease of held) lease.release();
});

test('a closed connection is replaced on the next acquire', async () => {
  const server = await fakeServer();
  const pool = makePool(server);

  const first = await pool.acquire('point', soon());
  first.release();
  connectionAt(server, 0).destroy();
  await waitFor('the pool to notice the closed connection', () => pool.stats().point.open === 0);

  const second = await pool.acquire('point', soon());

  assert.equal(server.connections.length, 2);
  assert.equal(pool.dialCount, 2);
  assert.notEqual(second.connection, first.connection);
  assert.equal(second.connection.closed, false);
  second.release();
});

test('hosts are tried in order and a dead first host falls through', async () => {
  const probe = await startFakeServer({ identity, onFrame: () => undefined });
  const deadPort = probe.port;
  await probe.close();

  const server = await fakeServer();
  const pool = makePool(server, {
    hosts: [
      { host: '127.0.0.1', port: deadPort, hostIndex: 0 },
      { host: '127.0.0.1', port: server.port, hostIndex: 1 },
    ],
  });

  const lease = await pool.acquire('point', soon());

  assert.equal(pool.dialCount, 2);
  assert.equal(lease.connection.address, `127.0.0.1:${server.port}`);
  lease.release();
});

test('a trust failure is not retried on the next host', async () => {
  const unpinned = await fakeServer();
  const pinned = await fakeServer();
  const pool = makePool(pinned, {
    hosts: [
      { host: '127.0.0.1', port: unpinned.port, hostIndex: 0 },
      { host: '127.0.0.1', port: pinned.port, hostIndex: 1 },
    ],
    trust: makeTrustPolicy({ knownServersPath: false }, [], 2),
  });

  await assert.rejects(
    pool.acquire('point', soon()),
    (error: TlsTrustError) => {
      assert.ok(error instanceof TlsTrustError);
      assert.equal(error.code, 'TLS_UNTRUSTED');
      assert.match(error.message, /your password never left this process/);
      return true;
    },
  );

  assert.equal(pool.dialCount, 1);
  assert.equal(pinned.connections.length, 0);
  // Nothing was written to the server whose key was refused either.
  assert.equal(unpinned.totalBytesReceived(), 0);
});

test('tick pings an idle connection and closes one past idle', async () => {
  let pings = 0;
  const server = await fakeServer((frame, conn) => {
    if (frame.opcode === Op.AUTH) conn.replyDoc(Op.AUTH_OK, frame.requestId, authOk());
    else if (frame.opcode === Op.PING) {
      pings += 1;
      conn.reply(Op.PONG, frame.requestId, new Uint8Array(0));
    }
  });

  let now = 1_000_000;
  const pool = makePool(server, { now: () => now, config: { idleTimeoutMs: 1_000, pingIntervalMs: 500 } });

  const lease = await pool.acquire('point', now + 5_000);
  lease.release();

  now += 600;
  await pool.tick();
  assert.equal(pings, 1);
  assert.equal(pool.stats().point.open, 1);
  assert.equal(lease.connection.closed, false);

  now += 2_000;
  await pool.tick();
  assert.equal(pings, 1);
  assert.equal(pool.stats().point.open, 0);
  assert.equal(lease.connection.closed, true);
});

test('tick refreshes the token once for many due connections', async () => {
  let tokenAuths = 0;
  const server = await fakeServer((frame, conn) => {
    if (frame.opcode === Op.AUTH) {
      const fields = decodeDocument(frame.payload, 'safe');
      if (typeof fields['token'] === 'string') tokenAuths += 1;
      conn.replyDoc(Op.AUTH_OK, frame.requestId, authOk({ token: 'tok-2' }));
    } else if (frame.opcode === Op.PING) conn.reply(Op.PONG, frame.requestId, new Uint8Array(0));
  });

  let now = Date.now();
  const pool = makePool(server, {
    now: () => now,
    // Both budgets are past the clock's move, so this tick is about the token and nothing else.
    config: { idleTimeoutMs: 3_600_000, pingIntervalMs: 1_800_000 },
  });

  const held = await Promise.all([1, 2, 3].map(() => pool.acquire('point', now + 5_000)));
  for (const lease of held) lease.release();
  assert.equal(server.connections.length, 3);
  // Three authenticated connections; which of them presented the token and which the password
  // depends on which AUTH_OK landed first, so only the sum is fixed.
  assert.equal(pool.session.passwordAuths + pool.session.tokenAuths, 3);
  tokenAuths = 0;
  const tokenAuthsBefore = pool.session.tokenAuths;

  now += 600_000;
  await pool.tick();

  assert.equal(tokenAuths, 1);
  assert.equal(pool.session.tokenAuths - tokenAuthsBefore, 1);
  assert.equal(pool.stats().point.open, 3);
  assert.equal(pool.session.needsRefresh(), false);
});

test('close never calls end and leaves no interval', async () => {
  const timeoutsBefore = activeTimeouts();
  const server = await fakeServer();
  const pool = makePool(server);

  const lease = await pool.acquire('point', soon());
  const socket = socketOf(lease.connection) as unknown as { end: (...args: unknown[]) => unknown };
  const originalEnd = socket.end.bind(socket);
  let endCalls = 0;
  socket.end = (...args: unknown[]): unknown => {
    endCalls += 1;
    return originalEnd(...args);
  };

  pool.start();
  lease.release();
  await pool.close(1_000);
  await sleep(50);

  // A half-close reads to the server as a client that has gone, so closing is destroy() only.
  assert.equal(endCalls, 0);
  assert.equal(lease.connection.closed, true);
  assert.deepEqual(pool.stats().point, { open: 0, inUse: 0, waiting: 0 });
  // The heartbeat timer is unref()ed and cleared, so an unclosed client never holds the process.
  assert.equal(activeTimeouts(), timeoutsBefore);

  await assert.rejects(
    pool.acquire('point', soon()),
    (error: Error) => {
      assert.equal(error.message, 'This client was closed. Create a new one with connect().');
      return true;
    },
  );
});

test('OVERLOADED on a third dial makes callers wait instead of failing', async () => {
  let refusals = 0;
  const server = await fakeServer((frame, conn) => {
    if (frame.opcode !== Op.AUTH) {
      serve(frame, conn);
      return;
    }
    // The server's connection budget is two: from the third connection it answers with its own
    // refusal (a zero request ID) and closes, which is what the real server does at accept time.
    if (server.connections.length >= 3) {
      refusals += 1;
      conn.replyDoc(Op.ERROR, new Uint8Array(16), { code: 13, message: 'connection budget full; retry shortly' });
      conn.destroy();
      return;
    }
    conn.replyDoc(Op.AUTH_OK, frame.requestId, authOk());
  });
  const pool = makePool(server);

  const held = [await pool.acquire('point', soon()), await pool.acquire('point', soon())];
  const third = pool.acquire('point', Date.now() + 20_000);
  await waitFor('the refused dial to leave the lane waiting', () => pool.stats().point.waiting === 1);
  assert.equal(refusals, 1);

  const leases: Lease[] = [];
  const cycles = Array.from({ length: 10 }, async () => {
    const lease = await pool.acquire('point', Date.now() + 20_000);
    leases.push(lease);
    await lease.connection.send(Op.PING, new Uint8Array(0), { timeoutMs: 5_000, expect: [Op.PONG] });
    lease.release();
  });
  for (const lease of held) lease.release();

  const thirdLease = await third;
  await Promise.all(cycles);

  assert.equal(refusals, 1);
  assert.equal(server.connections.length, 3);
  assert.equal(leases.length, 10);
  thirdLease.release();
  for (const lease of leases) lease.release();
});

/** The sentence the server writes when its connection budget is full (transport/tcp.go refuseMessage). */
const BUDGET_FULL =
  'server connection limit reached (1, HOARDDB_TCP_MAX_CONNS_PER_IP); retry shortly or raise the cap (currently 1 connections)';

function assertOverloaded(error: unknown): true {
  assert.ok(error instanceof OverloadedError, `expected OverloadedError, got ${String(error)}`);
  assert.equal(error.code, 'OVERLOADED');
  assert.equal(error.wireCode, 13);
  assert.equal(error.message, BUDGET_FULL, "the server's sentence, verbatim");
  assert.match(String(error.hint), /HOARDDB_TCP_MAX_CONNS_PER_IP/);
  return true;
}

test('OVERLOADED written right after the handshake is an OverloadedError with the server sentence', async () => {
  // The real server writes this refusal as soon as the handshake is done, without waiting for AUTH
  // (transport/tcp.go TCPListener.refuse), and then closes.
  const server = await fakeServer(serve, (conn) => {
    conn.replyDoc(Op.ERROR, new Uint8Array(16), { code: 13, message: BUDGET_FULL });
    conn.end();
  });
  const pool = makePool(server);

  await assert.rejects(pool.acquire('point', soon()), assertOverloaded);
  assert.equal(pool.stats().point.open, 0);
});

test('OVERLOADED in answer to AUTH is an OverloadedError with the server sentence', async () => {
  const server = await fakeServer((frame, conn) => {
    if (frame.opcode !== Op.AUTH) return;
    conn.replyDoc(Op.ERROR, new Uint8Array(16), { code: 13, message: BUDGET_FULL });
    conn.end();
  });
  const pool = makePool(server);

  await assert.rejects(pool.acquire('point', soon()), assertOverloaded);
  assert.equal(pool.stats().point.open, 0);
});

test('close while a dial is in flight refuses the caller and leaks no socket', async () => {
  const server = await fakeServer((frame, conn) => {
    // The login is slow, so close() lands while the dial is still in flight.
    if (frame.opcode === Op.AUTH) setTimeout(() => conn.replyDoc(Op.AUTH_OK, frame.requestId, authOk()), 200);
  });
  const pool = makePool(server);

  const pending = pool.acquire('point', soon());
  await waitFor('the login to reach the server', () => (server.connections[0]?.bytesReceived ?? 0) > 0);
  await pool.close(0);

  await assert.rejects(pending, (error: ClientClosedError) => {
    assert.ok(error instanceof ClientClosedError, `expected ClientClosedError, got ${String(error)}`);
    assert.equal(error.message, 'This client was closed. Create a new one with connect().');
    return true;
  });
  await waitFor('the dialled socket to be destroyed', () => server.connections[0]?.closed === true, 2_000);
  assert.deepEqual(pool.stats().point, { open: 0, inUse: 0, waiting: 0 });
});

test('a dial that fails outright backs the lane off before the next one', async () => {
  const probe = await startFakeServer({ identity, onFrame: () => undefined });
  const deadPort = probe.port;
  await probe.close();
  const placeholder = await fakeServer();
  // random() = 1: the backoff after one failed dial is its full 100 ms.
  const pool = makePool(placeholder, { hosts: [{ host: '127.0.0.1', port: deadPort, hostIndex: 0 }], random: () => 1 });

  const firstStarted = Date.now();
  await assert.rejects(pool.acquire('point', soon()), (error: Error & { code?: string }) => error.code === 'CONNECTION_FAILED');
  const firstMs = Date.now() - firstStarted;

  const secondStarted = Date.now();
  await assert.rejects(pool.acquire('point', soon()), (error: Error & { code?: string }) => error.code === 'CONNECTION_FAILED');
  const secondMs = Date.now() - secondStarted;

  assert.ok(firstMs < 90, `the first dial took ${firstMs} ms`);
  assert.ok(secondMs >= 90, `the second dial waited ${secondMs} ms after a refused connect, not the 100 ms backoff`);
  assert.equal(pool.dialCount, 2);
});

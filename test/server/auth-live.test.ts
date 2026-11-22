// SPDX-License-Identifier: Apache-2.0
//
// Leg 8 of the conformance harness (handbook testing.md section 2): authentication against real
// servers. The server's failed-login limiter counts per address, so every test here starts a server
// of its own; a failed login in one test must never be another test's rate limit.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { AuthenticationError, NotFoundError, connect, type Client } from '../../src/index.js';
import { Session } from '../../src/auth.js';
import { resolveOptions } from '../../src/options.js';
import { Pool } from '../../src/pool.js';
import { startServer, type StartOptions, type TestServer } from '../helpers/server.js';

/** These tests read keys that were never written to exercise the call, not the miss: a typed miss is the expected answer, shown as null. */
async function missing(bucket: { get(key: string): Promise<unknown> }, key: string): Promise<unknown> {
  return bucket.get(key).catch((error: unknown) => {
    if (error instanceof NotFoundError) return null;
    throw error;
  });
}

const TRUST = { knownServersPath: false } as const;

function poolOf(client: Client): Pool {
  const pool = (client as unknown as { pool: Pool | undefined }).pool;
  assert.ok(pool !== undefined, 'the client has a live pool');
  return pool;
}

/** Run a body against a server of its own, and stop the server and every client the body opened. */
async function withServer(
  options: StartOptions,
  body: (server: TestServer, open: (settings?: { pool?: { size?: number } }) => Promise<Client>) => Promise<void>,
): Promise<void> {
  const server = await startServer(options);
  const clients: Client[] = [];
  try {
    await body(server, async (settings = {}) => {
      const client = await connect(server.uri(), { tls: TRUST, ...settings });
      clients.push(client);
      return client;
    });
  } finally {
    for (const client of clients) await client.close({ timeoutMs: 1_000 });
    await server.stop();
  }
}

/** The pool exactly as connect() builds it, so a refused first login can still be counted. */
function bareFor(server: TestServer, password: string, size: number): Pool {
  const uri = `hoarddb://${server.user}:${encodeURIComponent(password)}@${server.address}?fingerprint=${server.fingerprint}`;
  const resolved = resolveOptions(uri, { tls: TRUST, pool: { size } }, {});
  const now = (): number => Date.now();
  return new Pool({
    hosts: resolved.hosts,
    trust: resolved.trust,
    dialTimeoutMs: resolved.dialTimeoutMs,
    session: new Session({ username: resolved.username, password: resolved.password }, now),
    config: resolved.pool,
    now,
    random: Math.random,
    onAuth: () => undefined,
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

/** A database and a hash bucket, and two reads at once so that a second connection is needed. */
async function twoConcurrentGets(client: Client): Promise<void> {
  await client.createDatabase('auth', { ifNotExists: true });
  const database = client.database('auth');
  await database.createBucket('users', 'hash', { ifNotExists: true });
  const users = database.hash('users');
  await Promise.all([missing(users, 'one'), missing(users, 'two')]);
}

test('a wrong password is CREDENTIALS and is not retried', async () => {
  await withServer({}, async (server) => {
    await assert.rejects(
      () => connect(server.uri().replace(encodeURIComponent(server.password), 'not-the-password'), { tls: TRUST }),
      (error: unknown) => error instanceof AuthenticationError && error.reason === 'CREDENTIALS',
    );

    const pool = bareFor(server, 'not-the-password', 4);
    try {
      await assert.rejects(
        () => pool.openFirst(Date.now() + 10_000),
        (error: unknown) => error instanceof AuthenticationError && error.reason === 'CREDENTIALS',
      );
      assert.equal(pool.dialCount, 1, 'one dial: a refused password is never tried again');
    } finally {
      await pool.close(0);
    }
  });
});

test('a token minted on one connection authenticates another', async () => {
  await withServer({}, async (_server, open) => {
    const client = await open({ pool: { size: 2 } });
    await twoConcurrentGets(client);
    const { session } = poolOf(client);
    assert.equal(session.passwordAuths, 1);
    assert.ok(session.tokenAuths >= 1, `the second connection used the token (${session.tokenAuths} token logins)`);
  });
});

test('an expired token falls back to the password once', async () => {
  await withServer({ env: { HOARDDB_TOKEN_TTL: '1', HOARDDB_AUTH_SKEW: '0' } }, async (_server, open) => {
    const client = await open({ pool: { size: 2 } });
    await sleep(2_500);
    await twoConcurrentGets(client);
    assert.equal(poolOf(client).session.passwordAuths, 2);
  });
});

test('RATE_LIMITED is not retried', async () => {
  await withServer({ env: { HOARDDB_TCP_AUTH_MAX_FAILS: '1' } }, async (server) => {
    await assert.rejects(
      () => connect(server.uri().replace(encodeURIComponent(server.password), 'not-the-password'), { tls: TRUST }),
      (error: unknown) => error instanceof AuthenticationError && error.reason === 'CREDENTIALS',
    );

    const pool = bareFor(server, server.password, 4);
    try {
      await assert.rejects(
        () => pool.openFirst(Date.now() + 10_000),
        (error: unknown) => error instanceof AuthenticationError && error.reason === 'RATE_LIMITED',
      );
      assert.equal(pool.dialCount, 1, 'one dial: a rate limit is not hammered');
    } finally {
      await pool.close(0);
    }
  });
});

test('refresh is single-flight', async () => {
  await withServer({ env: { HOARDDB_TOKEN_TTL: '4', HOARDDB_AUTH_SKEW: '0' } }, async (_server, open) => {
    const client = await open({ pool: { size: 4 } });
    await client.createDatabase('auth', { ifNotExists: true });
    const database = client.database('auth');
    await database.createBucket('users', 'hash', { ifNotExists: true });
    const users = database.hash('users');
    await Promise.all(['a', 'b', 'c', 'd'].map((key) => missing(users, key)));
    assert.equal(client.poolStats().point.open, 4, 'four connections are open');

    await sleep(2_500);
    const pool = poolOf(client);
    const before = pool.session.tokenAuths;
    await Promise.all([pool.tick(), pool.tick(), pool.tick()]);
    assert.equal(pool.session.tokenAuths - before, 1, 'three concurrent heartbeats refreshed the token once');
  });
});

test('a server restart closes pooled connections and the next call reconnects', async () => {
  await withServer({}, async (server, open) => {
    const client = await open();
    await client.createDatabase('auth', { ifNotExists: true });
    const database = client.database('auth');
    await database.createBucket('users', 'hash', { ifNotExists: true });
    const users = database.hash('users');
    assert.equal(await missing(users, 'ada'), null);

    const dialsBefore = poolOf(client).dialCount;
    await server.restart();
    assert.equal(await missing(users, 'ada'), null, 'the read is retried on a new connection');
    assert.ok(poolOf(client).dialCount > dialsBefore, 'a new connection was dialled');
  });
});

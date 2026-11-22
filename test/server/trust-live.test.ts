// SPDX-License-Identifier: Apache-2.0
//
// Leg 2 against a real server (handbook testing.md section 2): the fingerprint the driver computes
// is the one the server prints, a pin connects, and an unknown or changed key is refused with the
// way forward named. Only a real server proves the fingerprint matches its log line.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { acceptFirstSight, connect, TlsTrustError } from '../../src/index.js';
import { Connection } from '../../src/connection.js';
import { fingerprintOfPublicKey, makeTrustPolicy } from '../../src/trust.js';
import { startServer, type TestServer } from '../helpers/server.js';

let server: TestServer;
let scratch: string;

before(async () => {
  server = await startServer();
  scratch = mkdtempSync(join(tmpdir(), 'hoarddb-node-trust-'));
});

after(async () => {
  await server.stop();
  rmSync(scratch, { recursive: true, force: true });
});

/** A uri with the credentials but no pin, so the trust decision is the test's own. */
function unpinnedUri(): string {
  return `hoarddb://${server.user}:${encodeURIComponent(server.password)}@${server.address}`;
}

function knownServersFile(name: string, text: string): string {
  const dir = join(scratch, name);
  mkdirSync(dir, { recursive: true });
  chmodSync(dir, 0o700);
  const path = join(dir, 'known_servers');
  writeFileSync(path, text, { mode: 0o600 });
  return path;
}

test("the computed fingerprint equals the server's log line", async () => {
  let seen = '';
  const connection = await Connection.dial({
    target: { host: server.host, port: server.port, hostIndex: 0 },
    trust: makeTrustPolicy(
      {
        knownServersPath: false,
        onUnknownServer: (presented) => {
          seen = presented.fingerprint;
          return true;
        },
      },
      [],
      1,
    ),
    dialTimeoutMs: 10_000,
  });
  try {
    assert.equal(seen, server.fingerprint);
    assert.equal(connection.fingerprint, server.fingerprint);
  } finally {
    connection.destroy();
  }
});

test('connect by pin succeeds', async () => {
  const client = await connect(server.uri(), { tls: { knownServersPath: false } });
  try {
    await client.ping();
  } finally {
    await client.close();
  }
});

test('connect with an empty known_servers and no prompt is TLS_UNTRUSTED naming three ways', async () => {
  const path = knownServersFile('empty', '');
  await assert.rejects(
    () => connect(unpinnedUri(), { tls: { knownServersPath: path } }),
    (error: unknown) => {
      assert.ok(error instanceof TlsTrustError);
      assert.equal(error.code, 'TLS_UNTRUSTED');
      assert.ok(error.message.includes(server.fingerprint), 'the message names the key the server presented');
      assert.ok(error.message.includes('pin it'), 'way one: a pin');
      assert.ok(error.message.includes('known_servers'), 'way two: the command-line tool');
      assert.ok(error.message.includes('acceptFirstSight'), 'way three: the callback');
      return true;
    },
  );
});

test('connect with a known_servers holding another key is TLS_KEY_CHANGED naming both', async () => {
  const otherKey = 'ab'.repeat(32);
  const path = knownServersFile('changed', `${server.address} ${otherKey}\n`);
  await assert.rejects(
    () => connect(unpinnedUri(), { tls: { knownServersPath: path } }),
    (error: unknown) => {
      assert.ok(error instanceof TlsTrustError);
      assert.equal(error.code, 'TLS_KEY_CHANGED');
      assert.ok(error.message.includes(server.fingerprint), 'the message names the presented key');
      assert.ok(
        error.message.includes(fingerprintOfPublicKey(Buffer.from(otherKey, 'hex'))),
        'the message names the recorded key',
      );
      return true;
    },
  );
});

test('acceptFirstSight records the key and the next connect needs no prompt', async () => {
  const path = knownServersFile('first-sight', '');
  const first = await connect(unpinnedUri(), {
    tls: { knownServersPath: path, onUnknownServer: acceptFirstSight },
  });
  await first.close();

  const recorded = readFileSync(path, 'utf8');
  assert.match(recorded, new RegExp(`^${server.address.replaceAll('.', '\\.')} [0-9a-f]{64}$`, 'm'));

  const second = await connect(unpinnedUri(), { tls: { knownServersPath: path } });
  try {
    await second.ping();
  } finally {
    await second.close();
  }
});

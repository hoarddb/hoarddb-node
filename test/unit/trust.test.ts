// SPDX-License-Identifier: Apache-2.0
//
// The trust decision, before a password is ever written (handbook trust.md sections 2 to 4). The
// fingerprint is the SHA-256 of the raw 32 key bytes, never of the certificate, so the two vectors
// that carry a key with its certificate are what pin the string every driver must produce. The
// known_servers vectors are read as the shared file the command-line tool writes.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { X509Certificate } from 'node:crypto';

import { ConfigError } from '../../src/errors.js';
import {
  KnownServers,
  decideTrust,
  fingerprintOfPublicKey,
  makeTrustPolicy,
  parseKnownServers,
  publicKeyOfCertificate,
  type TrustDecision,
} from '../../src/trust.js';
import { hexToBytes, loadDriverVectors, type Vector } from '../helpers/vectors.js';

interface TrustVectorShape {
  name: string;
  fingerprint: string;
  public_key_hex?: string;
  certificate_pem?: string;
  known_servers?: {
    file_text: string;
    entries?: Record<string, string>;
    error_contains?: string;
  };
}

function trustVectors(): TrustVectorShape[] {
  return loadDriverVectors().vectors
    .filter((vector: Vector) => vector.kind === 'trust')
    .map((vector: Vector) => vector as unknown as TrustVectorShape);
}

function keyVectors(): TrustVectorShape[] {
  return trustVectors().filter((vector) => vector.public_key_hex !== undefined);
}

const KEY_ONE = keyVectors()[0] as TrustVectorShape;
const KEY_TWO = keyVectors()[1] as TrustVectorShape;

const ADDRESS = '127.0.0.1:7433';
const SCRATCH_DIRECTORIES: string[] = [];

function scratchDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'hoarddb-trust-'));
  SCRATCH_DIRECTORIES.push(directory);
  return directory;
}

/** A known_servers file in a private directory, holding exactly the lines it is given. */
function knownServersFile(lines: string[], mode = 0o600): string {
  const path = join(scratchDirectory(), 'known_servers');
  writeFileSync(path, lines.join('\n') + '\n', { mode });
  chmodSync(path, mode);
  return path;
}

function server(publicKeyHex: string): {
  host: string;
  port: number;
  hostIndex: number;
  publicKey: Uint8Array;
} {
  return {
    host: '127.0.0.1',
    port: 7433,
    hostIndex: 0,
    publicKey: hexToBytes(publicKeyHex),
  };
}

after(() => {
  for (const directory of SCRATCH_DIRECTORIES) rmSync(directory, { recursive: true, force: true });
});

test('every key vector\'s fingerprint matches from the key', () => {
  const keys = keyVectors();
  assert.ok(keys.length > 0, 'the vector file holds no key vectors');
  for (const vector of keys) {
    assert.equal(
      fingerprintOfPublicKey(hexToBytes(vector.public_key_hex as string)),
      vector.fingerprint,
      `the fingerprint of the key of "${vector.name}" does not match`,
    );
  }
});

test('every key vector\'s fingerprint matches from its certificate', () => {
  const keys = keyVectors();
  assert.ok(keys.length > 0, 'the vector file holds no key vectors');
  for (const vector of keys) {
    const der = new X509Certificate(vector.certificate_pem as string).raw;
    const fromCertificate = fingerprintOfPublicKey(publicKeyOfCertificate(der));
    assert.equal(fromCertificate, vector.fingerprint, `the fingerprint of the certificate of "${vector.name}" does not match`);
    assert.deepEqual(
      Buffer.from(publicKeyOfCertificate(der)).toString('hex'),
      vector.public_key_hex,
      `the key taken from the certificate of "${vector.name}" is not the vector's key`,
    );
  }
});

test('every known_servers vector loads to exactly its entries', () => {
  const files = trustVectors().filter((vector) => vector.known_servers?.entries !== undefined);
  assert.ok(files.length > 0, 'the vector file holds no known_servers vectors with entries');
  for (const vector of files) {
    const parsed = parseKnownServers(
      (vector.known_servers as { file_text: string }).file_text,
      '/var/empty/user/.hoarddb/known_servers',
    );
    assert.deepEqual(
      Object.fromEntries(parsed),
      vector.known_servers?.entries,
      `"${vector.name}" did not load to exactly its entries`,
    );
  }
});

test('the two-keys vector is refused with its error_contains', () => {
  const vector = trustVectors().find(
    (candidate) => candidate.known_servers?.error_contains !== undefined,
  );
  assert.ok(vector !== undefined, 'the vector file holds no vector refusing two keys');
  const refusal = (vector.known_servers as { file_text: string; error_contains: string });
  assert.throws(
    () => parseKnownServers(refusal.file_text, '/var/empty/user/.hoarddb/known_servers'),
    (error: unknown) => {
      assert.ok(error instanceof ConfigError, `"${vector?.name}" was not refused with a ConfigError`);
      assert.equal(error.code, 'INVALID_OPTIONS', `"${vector?.name}" refused with the wrong code`);
      assert.ok(
        error.message.includes(refusal.error_contains),
        `"${vector?.name}" was refused without "${refusal.error_contains}": ${error.message}`,
      );
      assert.ok(
        error.message.includes(KEY_ONE.fingerprint) && error.message.includes(KEY_TWO.fingerprint),
        `"${vector?.name}" did not name both keys: ${error.message}`,
      );
      return true;
    },
  );
});

test('a pin match passes without reading the file', async () => {
  // The file is world-writable, so reading it would be refused: a pinned host must never need it.
  const path = knownServersFile([`${ADDRESS} ${KEY_TWO.public_key_hex as string}`], 0o666);
  const policy = makeTrustPolicy({ knownServersPath: path }, [KEY_ONE.fingerprint], 1);

  const decision = await decideTrust(policy, server(KEY_ONE.public_key_hex as string));

  assert.equal(decision.ok, true, decision.ok ? '' : decision.error.message);
  if (!decision.ok) assert.fail('a matching pin must be trusted');
  assert.equal(decision.via, 'pin');
  assert.equal(decision.fingerprint, KEY_ONE.fingerprint);
});

test('a pin mismatch names both fingerprints', async () => {
  const policy = makeTrustPolicy({ knownServersPath: false }, [KEY_ONE.fingerprint], 1);

  const decision = await decideTrust(policy, server(KEY_TWO.public_key_hex as string));

  assert.equal(decision.ok, false, 'a mismatching pin must be refused');
  if (decision.ok) assert.fail('a mismatching pin must be refused');
  assert.equal(decision.error.code, 'TLS_FINGERPRINT_MISMATCH');
  assert.ok(
    decision.error.message.includes(KEY_ONE.fingerprint) && decision.error.message.includes(KEY_TWO.fingerprint),
    `the refusal did not name both fingerprints: ${decision.error.message}`,
  );
});

test('a changed key in the file is refused and the prompt is not called', async () => {
  const path = knownServersFile([`${ADDRESS} ${KEY_ONE.public_key_hex as string}`]);
  let promptCalls = 0;
  const policy = makeTrustPolicy(
    {
      knownServersPath: path,
      onUnknownServer: () => {
        promptCalls += 1;
        return true;
      },
    },
    [],
    1,
  );

  const decision = await decideTrust(policy, server(KEY_TWO.public_key_hex as string));

  assert.equal(decision.ok, false, 'a changed key must be refused');
  if (decision.ok) assert.fail('a changed key must be refused');
  assert.equal(decision.error.code, 'TLS_KEY_CHANGED');
  assert.equal(promptCalls, 0, 'a changed key must never be re-prompted');
  assert.ok(
    decision.error.message.includes(KEY_ONE.fingerprint) && decision.error.message.includes(KEY_TWO.fingerprint),
    `the refusal did not name both keys: ${decision.error.message}`,
  );
});

test('an unknown key with no prompt is refused naming three ways', async () => {
  const path = knownServersFile(['# nothing recorded yet']);
  const policy = makeTrustPolicy({ knownServersPath: path }, [], 1);

  const decision = await decideTrust(policy, server(KEY_ONE.public_key_hex as string));

  assert.equal(decision.ok, false, 'an unknown key must be refused');
  if (decision.ok) assert.fail('an unknown key must be refused');
  assert.equal(decision.error.code, 'TLS_UNTRUSTED');
  for (const way of ['fingerprint=', 'command-line tool', 'acceptFirstSight']) {
    assert.ok(
      decision.error.message.includes(way),
      `the refusal does not name "${way}": ${decision.error.message}`,
    );
  }
});

test('a prompt acceptance records the key once', async () => {
  const path = join(scratchDirectory(), 'known_servers');
  const policy = makeTrustPolicy(
    { knownServersPath: path, onUnknownServer: () => true },
    [],
    1,
  );

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const decision = await decideTrust(policy, server(KEY_ONE.public_key_hex as string));
    assert.equal(decision.ok, true, decision.ok ? '' : decision.error.message);
    if (!decision.ok) assert.fail('an accepted key must be trusted');
    // The first acceptance is the prompt; the second finds the key recorded by the first, so the
    // file is trusted and the line is not written twice.
    assert.equal(decision.via, attempt === 0 ? 'prompt' : 'known');
  }

  const recorded = readFileSync(path, 'utf8').split('\n').filter((line) => line.trim() !== '');
  assert.deepEqual(recorded, [`${ADDRESS} ${KEY_ONE.public_key_hex as string}`]);
});

test('insecure warns on every decision', async () => {
  const policy = makeTrustPolicy({ insecure: { reason: 'a local test server' } }, [], 1);
  const warnings: string[] = [];
  const listener = (warning: Error): void => {
    const code = (warning as Error & { code?: string }).code;
    if (code === 'HOARDDB_INSECURE_TLS') warnings.push(warning.message);
  };
  process.on('warning', listener);

  try {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const decision: TrustDecision = await decideTrust(
        policy,
        server(KEY_ONE.public_key_hex as string),
      );
      assert.equal(decision.ok, true);
      if (decision.ok) assert.equal(decision.via, 'insecure');
    }
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
  } finally {
    process.off('warning', listener);
  }

  assert.equal(warnings.length, 3, `the reason was warned ${warnings.length} time(s), not once per decision`);
  assert.ok(
    warnings[0]?.includes('a local test server') && (warnings[0] ?? '').includes(ADDRESS),
    `the warning does not name the reason and the address: ${warnings[0]}`,
  );
});

test('a world-writable known_servers file is refused with the chmod fix', async () => {
  const path = knownServersFile([`${ADDRESS} ${KEY_ONE.public_key_hex as string}`], 0o666);

  const refusal = await new KnownServers(path).lookup(ADDRESS).then(
    () => undefined,
    (error: unknown) => error,
  );

  assert.ok(refusal instanceof ConfigError, `a world-writable file was not refused: ${String(refusal)}`);
  assert.ok(
    refusal.message.includes(path) && refusal.message.includes('chmod 600'),
    `the refusal does not name the file and the fix: ${refusal.message}`,
  );
});
test('every combination of trust options keeps the key check', async () => {
  // Handbook trust.md section 3: verification is replaced by the driver's own key check, never
  // dropped, so every way of combining the options is built here and each one's decision is compared
  // with the order the handbook gives. Only insecure (named, with a reason) and a program's own
  // prompt may accept a key nothing recorded; nothing else lets an unknown key through.
  type Pin = 'none' | 'match' | 'mismatch';
  type Known = 'off' | 'empty' | 'same' | 'other';
  type Prompt = 'none' | 'accept' | 'reject';
  type Expected = { ok: true; via: 'pin' | 'known' | 'prompt' | 'insecure' } | { ok: false; code: string };

  const expectedOutcome = (pin: Pin, known: Known, prompt: Prompt, insecure: boolean): Expected => {
    if (insecure) return { ok: true, via: 'insecure' };
    if (pin === 'match') return { ok: true, via: 'pin' };
    if (pin === 'mismatch') return { ok: false, code: 'TLS_FINGERPRINT_MISMATCH' };
    if (known === 'same') return { ok: true, via: 'known' };
    if (known === 'other') return { ok: false, code: 'TLS_KEY_CHANGED' };
    if (prompt === 'accept') return { ok: true, via: 'prompt' };
    return { ok: false, code: 'TLS_UNTRUSTED' };
  };

  const silenceInsecure = (): void => undefined;
  process.on('warning', silenceInsecure);
  let combinations = 0;
  try {
    for (const pin of ['none', 'match', 'mismatch'] as const) {
      for (const known of ['off', 'empty', 'same', 'other'] as const) {
        for (const prompt of ['none', 'accept', 'reject'] as const) {
          for (const insecure of [false, true]) {
            const name = `pin ${pin}, known_servers ${known}, prompt ${prompt}, insecure ${insecure}`;
            const recorded = { off: null, empty: [], same: [KEY_ONE], other: [KEY_TWO] }[known];
            const knownServersPath =
              recorded === null
                ? false
                : knownServersFile(recorded.map((key) => `${ADDRESS} ${key.public_key_hex as string}`));
            const policy = makeTrustPolicy(
              {
                knownServersPath,
                ...(pin === 'none' ? {} : { fingerprints: [pin === 'match' ? KEY_ONE.fingerprint : KEY_TWO.fingerprint] }),
                ...(prompt === 'none' ? {} : { onUnknownServer: () => prompt === 'accept' }),
                ...(insecure ? { insecure: { reason: 'the combination test' } } : {}),
              },
              [],
              1,
            );

            const decision = await decideTrust(policy, server(KEY_ONE.public_key_hex as string));
            const expected = expectedOutcome(pin, known, prompt, insecure);
            combinations += 1;

            if (expected.ok) {
              assert.ok(decision.ok, `${name}: refused (${decision.ok ? '' : decision.error.code}), expected via ${expected.via}`);
              assert.equal(decision.via, expected.via, `${name}: trusted by the wrong rule`);
              assert.equal(decision.fingerprint, KEY_ONE.fingerprint, `${name}: the presented key's fingerprint`);
            } else {
              assert.ok(!decision.ok, `${name}: trusted via ${decision.ok ? decision.via : ''}, expected ${expected.code}`);
              assert.equal(decision.error.code, expected.code, `${name}: refused for the wrong reason`);
            }
          }
        }
      }
    }
    await new Promise<void>((resolveTick) => setImmediate(resolveTick));
  } finally {
    process.off('warning', silenceInsecure);
  }

  assert.equal(combinations, 72);
});

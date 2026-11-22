// SPDX-License-Identifier: Apache-2.0
//
// Every example runs against a real server and prints exactly its golden output. The examples are
// plain scripts that import the package by name, so they are run as a program would run them: from the
// built package (npm run build first), with the environment a developer has and nothing else.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { startServer, type TestServer } from '../helpers/server.js';

/** [script, golden file]: the CommonJS quickstart prints what the ES module one does. */
const EXAMPLES: readonly (readonly [string, string])[] = [
  ['hash.mjs', 'hash.txt'],
  ['alter.mjs', 'alter.txt'],
  ['btree.mjs', 'btree.txt'],
  ['fifo.mjs', 'fifo.txt'],
  ['consume.mjs', 'consume.txt'],
  ['lifo.mjs', 'lifo.txt'],
  ['heap.mjs', 'heap.txt'],
  ['blob.mjs', 'blob.txt'],
  ['fields.mjs', 'fields.txt'],
  ['errors.mjs', 'errors.txt'],
  ['trust.mjs', 'trust.txt'],
  ['quickstart.mjs', 'quickstart.txt'],
  ['quickstart.cjs', 'quickstart.txt'],
];

const STORE_TYPES = ['hash', 'btree', 'fifo', 'lifo', 'heap', 'blob'] as const;

let server: TestServer;
let home: string;

before(async () => {
  server = await startServer();
  home = mkdtempSync(join(tmpdir(), 'hoarddb-node-examples-'));
});

after(async () => {
  await server?.stop();
  if (home !== undefined) rmSync(home, { recursive: true, force: true });
});

test('every example runs against a server and prints its golden output', () => {
  assert.ok(
    existsSync(join(process.cwd(), 'dist', 'esm', 'index.js')) && existsSync(join(process.cwd(), 'dist', 'cjs', 'index.js')),
    'the package is not built: run npm run build before this test',
  );

  for (const [script, golden] of EXAMPLES) {
    // trust.mjs is the one example that meets a key it has no pin for, so it gets none.
    const pin = script === 'trust.mjs' ? '' : `?fingerprint=${server.fingerprint}`;
    const run = spawnSync(process.execPath, [join('examples', script)], {
      cwd: process.cwd(),
      encoding: 'utf8',
      timeout: 60_000,
      env: {
        PATH: process.env['PATH'] ?? '',
        HOME: home,
        HOARDDB_URI: `hoarddb://admin@127.0.0.1:${server.port}/${pin}`,
        HOARDDB_ROOT_PASSWORD: server.password,
      },
    });
    assert.equal(run.status, 0, `${script} exited ${String(run.status)}: ${run.stderr}`);

    // The port is the run's own and is the only varying text an example may print (trust.mjs names it).
    const printed = run.stdout.split(`127.0.0.1:${server.port}`).join('127.0.0.1:<port>');
    const expected = readFileSync(join('examples', 'golden', golden), 'utf8');
    assert.equal(printed, expected, `${script} printed something other than examples/golden/${golden}`);
  }
});

test('every store type has an example', () => {
  for (const type of STORE_TYPES) {
    assert.ok(existsSync(join(process.cwd(), 'examples', `${type}.mjs`)), `examples/${type}.mjs exists`);
  }
});

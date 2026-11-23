// SPDX-License-Identifier: Apache-2.0
//
// The README is a promise a developer copies from, so every code block in it is compiled against the
// package as it is, and the words it must contain (every store type, every error code) are checked.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const README = readFileSync(join(process.cwd(), 'README.md'), 'utf8');

/** The fenced blocks whose info string is exactly one of `kinds`, in order. */
function blocksOf(kinds: readonly string[]): string[] {
  const blocks: string[] = [];
  const fence = /^```(\S*)[^\n]*\n([\s\S]*?)^```/gm;
  for (const match of README.matchAll(fence)) {
    if (kinds.includes(match[1] ?? '')) blocks.push(match[2] ?? '');
  }
  return blocks;
}

test('every ts and js block in the README type-checks', () => {
  const blocks = blocksOf(['ts', 'js']);
  assert.ok(blocks.length >= 3, `the README holds at least three code blocks (found ${blocks.length})`);

  const directory = join(process.cwd(), 'build', 'readme');
  rmSync(directory, { recursive: true, force: true });
  mkdirSync(directory, { recursive: true });
  blocks.forEach((block, index) => {
    writeFileSync(join(directory, `block-${index}.mts`), block.replaceAll("from 'hoarddb'", "from '../../src/index.js'"));
  });
  writeFileSync(
    join(directory, 'tsconfig.json'),
    JSON.stringify({ extends: '../../tsconfig.json', compilerOptions: { noEmit: true }, include: ['*.mts', '../../src'] }),
  );

  const run = spawnSync(join(process.cwd(), 'node_modules', '.bin', 'tsc'), ['-p', join(directory, 'tsconfig.json')], {
    encoding: 'utf8',
  });
  assert.equal(run.status, 0, `the README's code does not type-check:\n${run.stdout}${run.stderr}`);
});

test('the README names every store type and every error code of section 5', () => {
  for (const type of ['hash', 'btree', 'fifo', 'lifo', 'heap', 'blob']) {
    assert.ok(README.includes(type), `the README names the ${type} store type`);
  }

  const codes = [
    'NOT_FOUND', 'ALREADY_EXISTS', 'PERMISSION_DENIED', 'INVALID_ARGUMENT', 'INTERNAL', 'UNAVAILABLE', 'TIMEOUT',
    'CONFLICT', 'QUOTA_EXCEEDED', 'UNSUPPORTED_VERSION', 'EARLY_DATA_REJECTED', 'NOT_AUTHENTICATED', 'OVERLOADED',
    'RESULT_TOO_LARGE', 'DUPLICATE_KEY', 'FIELD_TYPE', 'BATCH_TOO_LARGE', 'DOCUMENT_EXISTS', 'CONNECTION_FAILED', 'TLS_UNTRUSTED', 'TLS_FINGERPRINT_MISMATCH',
    'TLS_KEY_CHANGED', 'AUTH_FAILED', 'PROTOCOL_ERROR', 'REQUEST_TIMEOUT', 'ABORTED', 'CLIENT_CLOSED', 'POOL_TIMEOUT',
    'FRAME_TOO_LARGE', 'UNREADABLE_VALUE', 'INVALID_URI', 'INVALID_OPTIONS', 'UNSUPPORTED_FEATURE',
  ];
  for (const code of codes) assert.ok(README.includes(code), `the README names the error code ${code}`);
  assert.ok(README.includes('UNKNOWN('), 'the README names UNKNOWN(<n>)');
});

test('the README gives the install steps from a checkout and says nothing it should not', () => {
  // A fresh checkout has no dist/: the README must say to build before packing (npm pack also runs
  // the build, as prepack; pack-smoke proves that part).
  const steps = ['npm ci', 'npm run build', 'npm pack'];
  let at = -1;
  for (const step of steps) {
    const found = README.indexOf(step, at + 1);
    assert.ok(found > at, `the README gives "${step}" after the step before it`);
    at = found;
  }
  assert.ok(README.includes('`examples/`'), 'the README says where the examples are');
  assert.ok(README.includes('not in the tarball'), 'the README says the examples are not in the tarball');
  assert.ok(README.includes('ESNext.Disposable'), 'the README tells TypeScript users about lib');

  // Four wordings that were wrong (build doc N-60).
  assert.ok(!README.includes('0.0.0.0:7433'), 'the server listens on 127.0.0.1:7433 by default');
  assert.ok(!README.includes('a missing parent document is created'), '$set does not create the document itself');
  assert.ok(!/codes the server sends are[^.]*EARLY_DATA_REJECTED/.test(README), 'EARLY_DATA_REJECTED is never sent');
  assert.ok(README.includes('The outcome is unknown: read it back before resending'), 'the one exception to word for word is named');
});

test('the README says what the server tests were run against, and the manifest claims no release', () => {
  assert.ok(!README.includes('have not been re-run against v1.1.0'), 'the server tests have been run against v1.1.0');
  assert.ok(!/server commit named in `testing\/server\.json` \| `npm run test:server`/.test(README), 'the compatibility table names what test:server was run against');
  assert.match(README, /\| 0\.1\.0 \| hoardDB v1\.1\.0[^|]*\| `npm run test:server`/, 'the compatibility table has a v1.1.0 row for test:server');
  assert.ok(README.includes('test/server/cluster.test.ts'), 'the README names the test file that cannot run against v1.1.0');
  assert.ok(README.includes('HOARDDB_SERVER_BIN'), 'the README says how the server tests take their binary');

  // testing/server.json is read only by scripts/fetch-server.sh, for a download that does not exist yet:
  // it must say so, and must not pass for the server the tests are run against.
  const manifest = JSON.parse(readFileSync(join(process.cwd(), 'testing', 'server.json'), 'utf8')) as {
    published?: boolean;
    note?: string;
  };
  assert.equal(manifest.published, false, 'testing/server.json says no test-server release is published');
  assert.match(manifest.note ?? '', /HOARDDB_SERVER_BIN/, 'testing/server.json says how to run the server tests meanwhile');
});

test('the README scopes "put never replaces" to hash and btree, and says what a queue and a heap do', () => {
  assert.ok(!README.includes('**`put` inserts and never replaces.**'), 'the unscoped statement is false on fifo, lifo and heap');
  assert.match(README, /\*\*On a hash or btree bucket `put` inserts and never replaces\.\*\*/);
  assert.match(README, /fifo or lifo[^.]*adds another entry/, 'a queue takes a second entry with the same _id_');
  assert.match(README, /heap[^.]*replaces the entry/, 'a heap replaces the entry that holds the _id_ at that priority');
  const handbook = readFileSync(join(process.cwd(), 'handbook', 'operations.md'), 'utf8');
  assert.ok(!handbook.includes('never replaces) | `PUT`'), 'the verb table does not say put never replaces on every type');
  assert.ok(!handbook.includes('**`PUT` and insert never replace.**'), 'the note is scoped to hash and btree');
  assert.match(handbook, /\*\*On a hash or btree, `PUT` and insert never replace\.\*\*/);
});

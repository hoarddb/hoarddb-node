// SPDX-License-Identifier: Apache-2.0
//
// Runs compiled test files and fails unless the TAP summary says what the step expected.
// Without this a step could go green with its tests missing, empty or skipped, which is the
// failure mode this guards against: a passing run that tested nothing.
//
//   node scripts/expect-tests.mjs <compiled test file> [<more files>] <minimum passing count>

import { spawnSync } from 'node:child_process';

const args = process.argv.slice(2);
const minimum = Number.parseInt(args.pop() ?? '', 10);
const files = args;

if (files.length === 0 || !Number.isInteger(minimum) || minimum < 1) {
  process.stderr.write(
    'usage: expect-tests.mjs <compiled test file> [<more files>] <minimum passing count>\n',
  );
  process.exit(1);
}

// A server test without a server binary would silently prove nothing, so it refuses instead
// of skipping: the sentence names the script that builds the binary.
const serverFiles = files.filter((file) => file.includes(`${'server'}/`));
if (serverFiles.length > 0 && !process.env.HOARDDB_SERVER_BIN) {
  process.stderr.write(
    'HOARDDB_SERVER_BIN is not set: run scripts/fetch-server.sh and export its output (HOARDDB_SERVER_BIN=$(scripts/fetch-server.sh)), or point it at a hoardDB-server binary\n',
  );
  process.exit(1);
}

const run = spawnSync(
  process.execPath,
  ['--test', '--test-concurrency=1', '--test-reporter=tap', ...files],
  { stdio: ['ignore', 'pipe', 'inherit'] },
);

if (run.stdout !== null) process.stdout.write(run.stdout.toString());

const summary = new Map();
for (const match of (run.stdout?.toString() ?? '').matchAll(/^# (pass|fail|cancelled|skipped|todo) (\d+)$/gm)) {
  summary.set(match[1], Number.parseInt(match[2] ?? '0', 10));
}

const counts = { pass: 0, fail: 0, cancelled: 0, skipped: 0, todo: 0 };
for (const key of Object.keys(counts)) counts[key] = summary.get(key) ?? -1;

const problems = [];
if (counts.pass < 0) problems.push('the test run printed no TAP summary');
if (counts.pass < minimum) {
  problems.push(`expected at least ${minimum} passing tests, the summary reports ${counts.pass}`);
}
for (const key of ['fail', 'cancelled', 'skipped', 'todo']) {
  if (counts[key] !== 0) problems.push(`expected 0 ${key} tests, the summary reports ${counts[key]}`);
}

if (problems.length > 0) {
  process.stderr.write(`expect-tests: ${problems.join('; ')}\n`);
  process.exit(1);
}
if (run.status !== 0) {
  process.stderr.write(`expect-tests: the test runner exited ${run.status}\n`);
  process.exit(1);
}

process.stdout.write(`expect-tests: ${counts.pass} passing tests, all accounted for\n`);

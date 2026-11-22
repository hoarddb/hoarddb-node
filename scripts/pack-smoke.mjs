// SPDX-License-Identifier: Apache-2.0
//
// Installs the package the way a user would, from the tarball npm makes, into an empty project, and
// checks what a user gets: it loads as ES module and as CommonJS, its only runtime dependency is the
// codec, no codec type leaks into its declarations, a consumer compiles against it with nothing but the
// language (no @types/node), and an error made by one build is recognised by the other.
// Run after npm run build. Exits 1 on the first failure. It also packs a copy of the sources without
// dist/, which only works because package.json's prepack builds it.

import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CODEC = 'b' + 'son';

let tarball;
let project;
let fresh;

function run(command, args, cwd, label) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) {
    fail(`${label} failed (exit ${String(result.status)}):\n${result.stdout}${result.stderr}`);
  }
  return result.stdout;
}

function fail(message) {
  process.stderr.write(`pack-smoke FAILED: ${message}\n`);
  cleanup();
  process.exit(1);
}

function cleanup() {
  if (fresh !== undefined) rmSync(fresh, { recursive: true, force: true });
  if (project !== undefined) rmSync(project, { recursive: true, force: true });
  if (tarball !== undefined) rmSync(tarball, { force: true });
}

function declarationFiles(directory) {
  const found = [];
  for (const name of readdirSync(directory)) {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) found.push(...declarationFiles(path));
    else if (name.endsWith('.d.ts')) found.push(path);
  }
  return found;
}

/** npm pack --json's answer; the prepack build may print a line of its own before it. */
function packJson(stdout, label) {
  const start = stdout.search(/^\[/m);
  if (start === -1) fail(`${label} printed no JSON:\n${stdout}`);
  return JSON.parse(stdout.slice(start));
}

// A fresh checkout has no dist/: npm pack must build it (the prepack script), or the tarball a user
// installs from holds no code. Packed here from a copy of the sources without dist/ (N-60).
fresh = mkdtempSync(join(tmpdir(), 'hoarddb-node-fresh-'));
for (const entry of ['src', 'scripts', 'package.json', 'README.md', 'LICENSE', 'tsconfig.json', 'tsconfig.esm.json', 'tsconfig.cjs.json']) {
  cpSync(join(packageRoot, entry), join(fresh, entry), { recursive: true });
}
symlinkSync(join(packageRoot, 'node_modules'), join(fresh, 'node_modules'), 'dir');
const freshFiles = packJson(run('npm', ['pack', '--json', '--silent'], fresh, 'npm pack of an unbuilt tree'), 'npm pack of an unbuilt tree')[0].files.map((file) => file.path);
for (const wanted of ['dist/esm/index.js', 'dist/esm/index.d.ts', 'dist/cjs/index.js', 'dist/cjs/index.d.ts']) {
  if (!freshFiles.includes(wanted)) fail(`npm pack of an unbuilt tree left out ${wanted}: package.json needs "prepack": "npm run build" (it packed ${freshFiles.length} files)`);
}
rmSync(fresh, { recursive: true, force: true });
fresh = undefined;

const packed = packJson(run('npm', ['pack', '--json', '--silent'], packageRoot, 'npm pack'), 'npm pack');
tarball = join(packageRoot, packed[0].filename);

project = mkdtempSync(join(tmpdir(), 'hoarddb-node-pack-'));
run('npm', ['init', '-y'], project, 'npm init');
run('npm', ['install', tarball, '--ignore-scripts', '--no-audit', '--no-fund', '--prefer-offline'], project, 'npm install of the tarball');

run(process.execPath, ['--input-type=module', '-e', "import { connect, isHoardDBError } from 'hoarddb'; if (typeof connect !== 'function' || typeof isHoardDBError !== 'function') process.exit(1)"], project, 'the ES module import');
run(process.execPath, ['-e', "const m = require('hoarddb'); if (typeof m.connect !== 'function') process.exit(1)"], project, 'the CommonJS require');

const tree = run('npm', ['ls', '--omit=dev', '--all', '--parseable'], project, 'npm ls')
  .split('\n')
  .filter((line) => line !== '' && resolve(line) !== resolve(project))
  .map((line) => basename(line))
  .sort();
if (tree.join(',') !== `${CODEC},hoarddb`) fail(`the runtime tree is ${tree.join(', ')}; it must be hoarddb and ${CODEC} only`);

// The check: a declaration may say the word, but may not name the package as a module (N-58).
const NAMES_THE_PACKAGE =
  /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|\bimport\s+)['"]bson(?:\/[^'"]*)?['"]|\/\/\/\s*<reference\s+types\s*=\s*['"]bson(?:\/[^'"]*)?['"]/;

// Negative control, run first, so the check cannot pass by matching nothing.
const MUST_BE_REFUSED = [
  `export type { ObjectId } from '${CODEC}';`,
  `import type { Binary } from "${CODEC}";`,
  `export * from '${CODEC}/lib/${CODEC}';`,
  `type T = import('${CODEC}').Long;`,
  `/// <reference types="${CODEC}" />`,
  `const b = require('${CODEC}');`,
];
for (const planted of MUST_BE_REFUSED) {
  if (!NAMES_THE_PACKAGE.test(planted)) fail(`the declaration check does not refuse: ${planted}`);
}
if (NAMES_THE_PACKAGE.test(`export interface Opaque { readonly ${CODEC}Type: string }`)) {
  fail('the declaration check refuses a field that only has the word in its name');
}

const installed = join(project, 'node_modules', 'hoarddb', 'dist');
for (const file of declarationFiles(installed)) {
  if (NAMES_THE_PACKAGE.test(readFileSync(file, 'utf8'))) fail(`${file} names the ${CODEC} package as a module: no declaration may depend on it`);
}

writeFileSync(
  join(project, 'consumer.mts'),
  `import { connect, type HashBucket } from 'hoarddb';
export async function main(): Promise<number> {
  const client = await connect('hoarddb://localhost');
  const users: HashBucket = client.database('app').hash('users');
  const found = await users.get('ada');
  await client.close();
  return found === null ? 0 : 1;
}
`,
);
writeFileSync(
  join(project, 'consumer.cts'),
  `import hoarddb = require('hoarddb');
export async function main(): Promise<number> {
  const client = await hoarddb.connect('hoarddb://localhost');
  const users: hoarddb.HashBucket = client.database('app').hash('users');
  const found = await users.get('ada');
  await client.close();
  return found === null ? 0 : 1;
}
`,
);
writeFileSync(join(project, 'tsconfig.json'), JSON.stringify({ compilerOptions: { noEmit: true, strict: true, module: 'nodenext', moduleResolution: 'nodenext', lib: ['es2022', 'esnext.disposable', 'dom'], types: [], skipLibCheck: false }, files: ['consumer.mts', 'consumer.cts'] }));
run(join(packageRoot, 'node_modules', '.bin', 'tsc'), ['-p', 'tsconfig.json'], project, 'the consumer type-check without @types/node');

run(
  process.execPath,
  [
    '--input-type=module',
    '-e',
    `import { createRequire } from 'node:module';
import { isHoardDBError, NotFoundError } from 'hoarddb';
const cjs = createRequire(import.meta.url)('hoarddb');
if (!isHoardDBError(new cjs.NotFoundError({ message: 'm', operation: 'get' }))) process.exit(1);
if (!cjs.isHoardDBError(new NotFoundError({ message: 'm', operation: 'get' }))) process.exit(2);`,
  ],
  project,
  'recognising an error across the two builds, both ways',
);

cleanup();
process.stdout.write('pack-smoke: the tarball installs, loads both ways, has one runtime dependency and a clean public surface\n');

// SPDX-License-Identifier: Apache-2.0
//
// The package lint: no dependency, no build step, just Node. It prints every violation as
// "path:line: rule: text" and exits 1 if there is any, so a step's "npm run check" fails on
// a stray word as surely as on a type error.
//
// The scanner necessarily names the words it bans, so two tokens below are assembled from
// parts and this file is skipped by rule 2; rule 1 still applies to it in full.

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const SKIPPED_DIRECTORIES = new Set(['node_modules', 'build', 'dist', '.cache', '.git']);
const CODE_EXTENSIONS = ['.ts', '.mjs', '.cjs', '.js', '.sh'];
const SCANNED_DIRECTORIES = ['src', 'test', 'scripts', 'examples'];
const ROOT_FILES = ['README.md', 'package.json'];

// Rule 1 forbids these words in every file; the scanner must not trip on its own source.
const LICENCE_TERMS = ['B' + 'SL', 'Business' + ' Source'];
const SPDX_LINE = 'SPDX-License-Identifier: Apache-2.0';

const BANNED_TERMS = [
  'mongo',
  'mysql',
  'mariadb',
  'drop-in',
  'compatible with',
  'wire-compatible',
  '-compatible',
  '-like',
];
const TERM_SCAN_SKIPPED = ['scripts/lint.mjs', 'scripts/ip-allowlist.json', 'scripts/compliance-check.sh'];

const CODEC_MODULE = 'b' + 'son';
const IMPORT_SPECIFIER =
  /(?:from|import|require)\s*\(?\s*['"]([^'"]+)['"]/g;
const BSON_IMPORT = new RegExp(`(?:from|import|require)\\s*\\(?\\s*['"]${CODEC_MODULE}['"]`);

const FORBIDDEN_IMPORT_FRAGMENTS = ['hoardDB/', 'clients/go'];
const SRC_SLOP = ['console.', 'debugger', ': any', 'as any', '<any>', '@ts-ignore', '@ts-nocheck'];
const TEST_DISABLERS = ['.only(', 'only: true', '.skip(', 'skip: true', '.todo(', 'todo: true'];
const ALLOWED_LICENCES = new Set([
  'MIT',
  'ISC',
  'Apache-2.0',
  'BSD-2-Clause',
  'BSD-3-Clause',
  '0BSD',
  'CC0-1.0',
  'Unlicense',
  'MPL-2.0',
]);
const REQUIRED_DEPENDENCIES = { bson: '7.3.3' };
const REQUIRED_DEV_DEPENDENCIES = {
  '@types/node': '22.20.5',
  publint: '0.3.25',
  typescript: '5.9.3',
};

const violations = [];

function report(file, line, rule, text) {
  violations.push(`${file}:${line}: ${rule}: ${text}`);
}

function walk(directory) {
  const found = [];
  for (const entry of readdirSync(directory)) {
    if (SKIPPED_DIRECTORIES.has(entry)) continue;
    const full = join(directory, entry);
    if (statSync(full).isDirectory()) found.push(...walk(full));
    else if (!entry.endsWith('.json') || full === join(packageRoot, 'package.json')) found.push(full);
  }
  return found;
}

function scannedFiles() {
  const files = [];
  for (const directory of SCANNED_DIRECTORIES) {
    const full = join(packageRoot, directory);
    if (existsSync(full)) files.push(...walk(full));
  }
  for (const file of ROOT_FILES) {
    const full = join(packageRoot, file);
    if (existsSync(full)) files.push(full);
  }
  return files;
}

function readAllowlist() {
  const path = join(packageRoot, 'scripts', 'ip-allowlist.json');
  if (!existsSync(path)) return [];
  return JSON.parse(readFileSync(path, 'utf8'));
}

function hasLicenceHeader(text, extension) {
  const lines = text.split('\n');
  const comment = extension === '.sh' ? '#' : '//';
  const [first, second] = lines;
  if (first !== undefined && first.trim() === `${comment} ${SPDX_LINE}`) return true;
  if (first !== undefined && first.startsWith('#!') && second !== undefined) {
    return second.trim() === `${comment} ${SPDX_LINE}`;
  }
  return false;
}

function checkLicenceHeader(file, text) {
  const extension = file.slice(file.lastIndexOf('.'));
  if (!CODE_EXTENSIONS.includes(extension)) return;
  if (!hasLicenceHeader(text, extension)) {
    report(file, 1, 'licence-header', `missing "${comment(extension)} ${SPDX_LINE}" as the first line`);
  }
}

function comment(extension) {
  return extension === '.sh' ? '#' : '//';
}

function checkBannedTerms(file, text, allowlist) {
  if (TERM_SCAN_SKIPPED.includes(relative(packageRoot, file))) return;
  const entries = allowlist.filter(
    (entry) => entry.path === relative(packageRoot, file) || entry.path === file,
  );
  text.split('\n').forEach((line, index) => {
    const lower = line.toLowerCase();
    for (const term of BANNED_TERMS) {
      if (!lower.includes(term)) continue;
      const allowance = entries.find((entry) => line.includes(entry.contains));
      if (allowance !== undefined) continue;
      report(file, index + 1, 'banned-term', `"${term}" in: ${line.trim()}`);
    }
  });
}

function checkCodecSeam(file, text) {
  if (relative(packageRoot, file).startsWith(`src${sep}codec${sep}`)) return;
  text.split('\n').forEach((line, index) => {
    if (BSON_IMPORT.test(line)) {
      report(file, index + 1, 'codec-seam', `"${CODEC_MODULE}" may be imported only from src/codec/`);
    }
  });
}

function checkBoundary(file, text) {
  const isSource = relative(packageRoot, file).startsWith(`src${sep}`);
  const isTest = relative(packageRoot, file).startsWith(`test${sep}`);
  text.split('\n').forEach((line, index) => {
    for (const match of line.matchAll(IMPORT_SPECIFIER)) {
      const specifier = match[1] ?? '';
      for (const fragment of FORBIDDEN_IMPORT_FRAGMENTS) {
        if (specifier.includes(fragment)) {
          report(file, index + 1, 'boundary', `import "${specifier}" crosses the package boundary`);
        }
      }
      if (!specifier.startsWith('.') || !(isSource || isTest)) continue;
      const target = resolve(dirname(file), specifier);
      const inside = relative(packageRoot, target);
      if (inside === '' || inside.startsWith('..') || resolve(packageRoot, inside) !== target) {
        report(file, index + 1, 'boundary', `import "${specifier}" resolves outside this package`);
      }
    }
  });
}

function checkSrcSlop(file, text) {
  text.split('\n').forEach((line, index) => {
    for (const pattern of SRC_SLOP) {
      if (line.includes(pattern)) {
        report(file, index + 1, 'src-slop', `"${pattern}" is not allowed in src/`);
      }
    }
  });
}

function checkExpectErrorPlacement(file, text) {
  const name = relative(packageRoot, file);
  const isSource = name.startsWith(`src${sep}`);
  const isTest = name.startsWith(`test${sep}`);
  if (!(isSource || isTest) || name.startsWith(`test${sep}types${sep}`)) return;
  text.split('\n').forEach((line, index) => {
    if (line.includes('@ts-expect-error')) {
      report(file, index + 1, 'ts-expect-error', 'allowed only under test/types/');
    }
  });
}

function checkDisabledTests(file, text) {
  text.split('\n').forEach((line, index) => {
    for (const pattern of TEST_DISABLERS) {
      if (line.includes(pattern)) {
        report(file, index + 1, 'disabled-test', `"${pattern}" disables a test`);
      }
    }
  });
}

function checkVersionAgreement(manifest) {
  const file = join(packageRoot, 'src', 'version.ts');
  const name = relative(packageRoot, file);
  if (!existsSync(file)) {
    report(name, 1, 'version', 'src/version.ts is missing');
    return;
  }
  const match = /DRIVER_VERSION\s*=\s*'([^']+)'/.exec(readFileSync(file, 'utf8'));
  if (match === null) {
    report(name, 1, 'version', 'DRIVER_VERSION is not declared as a single-quoted constant');
    return;
  }
  if (match[1] !== manifest.version) {
    report(name, 1, 'version', `DRIVER_VERSION ${match[1]} does not match package.json ${manifest.version}`);
  }
}

function sameSets(actual, expected) {
  const actualKeys = Object.keys(actual ?? {}).sort();
  const expectedKeys = Object.keys(expected).sort();
  if (actualKeys.join(',') !== expectedKeys.join(',')) return false;
  return expectedKeys.every((key) => actual?.[key] === expected[key]);
}

function checkDependencySets(manifest) {
  if (!sameSets(manifest.dependencies, REQUIRED_DEPENDENCIES)) {
    report('package.json', 1, 'dependencies', `must be exactly ${JSON.stringify(REQUIRED_DEPENDENCIES)}`);
  }
  if (!sameSets(manifest.devDependencies, REQUIRED_DEV_DEPENDENCIES)) {
    report(
      'package.json',
      1,
      'devDependencies',
      `must be exactly ${JSON.stringify(REQUIRED_DEV_DEPENDENCIES)}`,
    );
  }
}

function manifestsIn(directory) {
  const found = [];
  for (const entry of readdirSync(directory)) {
    const full = join(directory, entry);
    if (statSync(full).isDirectory()) found.push(...manifestsIn(full));
    else if (entry === 'package.json') found.push(full);
  }
  return found;
}

function checkInstalledLicences() {
  const modules = join(packageRoot, 'node_modules');
  if (!existsSync(modules)) return;
  for (const manifestPath of manifestsIn(modules)) {
    const name = relative(packageRoot, manifestPath);
    const licence = JSON.parse(readFileSync(manifestPath, 'utf8')).license;
    if (!ALLOWED_LICENCES.has(licence)) {
      report(name, 1, 'licence', `licence ${JSON.stringify(licence)} is outside the allowed list`);
    }
  }
}

const manifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'));
const allowlist = readAllowlist();

for (const file of scannedFiles()) {
  const text = readFileSync(file, 'utf8');
  const name = relative(packageRoot, file);
  const isSource = name.startsWith(`src${sep}`);
  const isTest = name.startsWith(`test${sep}`);
  checkLicenceHeader(file, text);
  checkBannedTerms(file, text, allowlist);
  checkCodecSeam(file, text);
  checkBoundary(file, text);
  if (isSource) checkSrcSlop(file, text);
  checkExpectErrorPlacement(file, text);
  if (isTest) checkDisabledTests(file, text);
}

checkVersionAgreement(manifest);
checkDependencySets(manifest);
checkInstalledLicences();

if (violations.length > 0) {
  for (const violation of violations) process.stdout.write(`${violation}\n`);
  process.stderr.write(`lint: ${violations.length} violation(s)\n`);
  process.exit(1);
}

process.stdout.write('lint: no violations\n');

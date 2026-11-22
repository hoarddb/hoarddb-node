// SPDX-License-Identifier: Apache-2.0
//
// Proves the lint can fail: a copy of the package gets one planted violation per rule and the lint
// must exit 1 on each, and 0 on the clean copy. A lint that never fails is a lint nobody reads.
//
// The planted text is assembled from pieces so that this file does not itself contain what the lint
// looks for (it is scanned like every other script).

import { spawnSync } from 'node:child_process';
import { appendFileSync, cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SPDX = '// SPDX-License-Identifier: Apache-2.0\n';
const SKIPPED = new Set(['node_modules', 'build', 'dist', '.cache', '.git']);

/** The lint, run inside a copy of the package; the exit status is all that is asked of it. */
function lintStatus(directory) {
  return spawnSync(process.execPath, ['scripts/lint.mjs'], { cwd: directory, encoding: 'utf8' }).status;
}

function copyOfPackage() {
  const directory = mkdtempSync(join(tmpdir(), 'hoarddb-node-lint-'));
  for (const name of ['src', 'test', 'scripts']) {
    cpSync(join(packageRoot, name), join(directory, name), {
      recursive: true,
      filter: (source) => !SKIPPED.has(source.split('/').pop() ?? ''),
    });
  }
  cpSync(join(packageRoot, 'package.json'), join(directory, 'package.json'));
  return directory;
}

const IMPORT = 'im' + 'port';
const FROM = 'fr' + 'om';
const CODEC = 'b' + 'son';

const PLANTED = [
  ['a file without the licence line', (dir) => writeFileSync(join(dir, 'src', 'planted.ts'), 'export const planted = 1;\n')],
  ['a banned term', (dir) => writeFileSync(join(dir, 'src', 'planted.ts'), `${SPDX}// built on ${'mon' + 'go'}\nexport const planted = 1;\n`)],
  ['the codec module imported outside src/codec', (dir) => appendFileSync(join(dir, 'src', 'client.ts'), `\n${IMPORT} '${CODEC}';\n`)],
  [
    'an import that leaves the package',
    (dir) => writeFileSync(join(dir, 'src', 'planted.ts'), `${SPDX}${IMPORT} { planted } ${FROM} '../../${'hoard' + 'DB'}/x';\nexport const other = planted;\n`),
  ],
  ['a console call in src', (dir) => writeFileSync(join(dir, 'src', 'planted.ts'), `${SPDX}${'console' + '.log'}('planted');\nexport const planted = 1;\n`)],
  [
    'a focused test',
    (dir) =>
      writeFileSync(
        join(dir, 'test', 'unit', 'planted.test.ts'),
        `${SPDX}${IMPORT} { test } ${FROM} 'node:test';\ntest${'.on' + 'ly'}('planted', () => undefined);\n`,
      ),
  ],
  ['a version mismatch', (dir) => writeFileSync(join(dir, 'src', 'version.ts'), `${SPDX}export const DRIVER_VERSION = '9.9.9';\n`)],
  [
    'an extra dependency',
    (dir) => {
      const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
      manifest.dependencies = { ...manifest.dependencies, 'left-pad': '1.3.0' };
      writeFileSync(join(dir, 'package.json'), JSON.stringify(manifest, null, 2));
    },
  ],
];

const failures = [];
const clean = copyOfPackage();
try {
  const status = lintStatus(clean);
  if (status !== 0) failures.push(`the clean copy failed the lint (exit ${status})`);
} finally {
  rmSync(clean, { recursive: true, force: true });
}

for (const [what, plant] of PLANTED) {
  const directory = copyOfPackage();
  try {
    plant(directory);
    const status = lintStatus(directory);
    if (status !== 1) failures.push(`the lint did not fail on ${what} (exit ${status})`);
    else process.stdout.write(`lint-selftest: refused ${what}\n`);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

if (failures.length > 0) {
  process.stderr.write(`lint-selftest FAILED:\n  ${failures.join('\n  ')}\n`);
  process.exit(1);
}
process.stdout.write(`lint-selftest: the clean copy passes and all ${PLANTED.length} planted violations are refused\n`);

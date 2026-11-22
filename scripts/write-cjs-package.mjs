// SPDX-License-Identifier: Apache-2.0
//
// The CommonJS half of the dual build needs its own manifest: the package is "type": "module",
// so without this file Node reads dist/cjs/*.js as ES modules and the require condition breaks.

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cjsDir = resolve(packageRoot, 'dist', 'cjs');

mkdirSync(cjsDir, { recursive: true });
writeFileSync(resolve(cjsDir, 'package.json'), `${JSON.stringify({ type: 'commonjs' }, null, 2)}\n`);

process.stdout.write('write-cjs-package: wrote dist/cjs/package.json\n');

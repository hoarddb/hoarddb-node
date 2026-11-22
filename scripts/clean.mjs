// SPDX-License-Identifier: Apache-2.0
//
// Removes the directories named on the command line. A build script that deletes the wrong
// tree is unrecoverable, so a target outside the package root is refused rather than removed.

import { rmSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

for (const target of process.argv.slice(2)) {
  const resolved = resolve(packageRoot, target);
  const inside = relative(packageRoot, resolved);
  if (inside === '' || inside.startsWith('..') || resolve(packageRoot, inside) !== resolved) {
    process.stderr.write(`clean: refusing to remove "${target}": it is outside the package\n`);
    process.exit(1);
  }
  rmSync(resolved, { recursive: true, force: true });
}

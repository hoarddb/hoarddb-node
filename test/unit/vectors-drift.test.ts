// SPDX-License-Identifier: Apache-2.0
//
// testdata/ is a copy of the vectors every hoardDB driver is tested against. In the hoardDB source
// tree the originals sit beside this package, and a copy that has fallen behind them hides every
// change the server made since: a new error code reads as UNKNOWN and a new verb is never built. So
// where the originals are present each copied file must equal its original, byte for byte. In the
// driver's own repository there is no original beside it, and the check says so and compares nothing.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const COPIED = resolve(process.cwd(), 'testdata');
const ORIGINALS = resolve(process.cwd(), '..', 'testdata');

test('every vector file under testdata/ equals the shared original', (t) => {
  if (!existsSync(join(ORIGINALS, 'driver-vectors', 'v1.json'))) {
    t.diagnostic(`no shared vectors at ${ORIGINALS}: this is the driver's own repository, nothing to compare`);
    return;
  }
  let compared = 0;
  for (const directory of readdirSync(COPIED)) {
    for (const file of readdirSync(join(COPIED, directory))) {
      const original = join(ORIGINALS, directory, file);
      assert.ok(existsSync(original), `testdata/${directory}/${file} has no original at ${original}`);
      assert.ok(
        readFileSync(join(COPIED, directory, file)).equals(readFileSync(original)),
        `testdata/${directory}/${file} differs from ${original}: copy the original over it, then fix what the driver's tests report`,
      );
      compared += 1;
    }
  }
  assert.ok(compared >= 5, `expected at least 5 vector files, compared ${compared}`);
});

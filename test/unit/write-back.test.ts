// SPDX-License-Identifier: Apache-2.0
//
// Write-back never alters data: a stored value the driver cannot read faithfully is refused on read,
// and a value that does round-trip keeps its bytes. Ported from the org node driver's write-back
// tests, with the BSON byte corpus replaced by the literal bytes of the vectors it named.

import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { decodeDocument, encodeDocument, isOpaque } from '../../src/codec/index.js';
import type { Opaque } from '../../src/codec/index.js';
import { bytesToHex, hexToBytes } from '../helpers/vectors.js';

/** BSON corpus vector regex/empty: { a: /""/ with no options }. */
const REGEX_EMPTY = '0a0000000b6100000000';
/** BSON corpus vector decode/regex-options-unsorted: { a: /p/ with the options "xi" stored in that order }. */
const REGEX_OPTIONS_UNSORTED = '0d0000000b6100700078690000';

test('regex: an empty pattern is written back as stored, never as "(?:)"', () => {
  const read = decodeDocument(hexToBytes(REGEX_EMPTY), 'safe');
  assert.ok(isOpaque(read['a']), 'a regex is surfaced as an Opaque');
  assert.equal(bytesToHex(encodeDocument(read)), REGEX_EMPTY);
});

test('regex: options the language does not know survive a write-back', () => {
  const read = decodeDocument(hexToBytes(REGEX_OPTIONS_UNSORTED), 'safe');
  assert.ok(isOpaque(read['a']), 'a regex with options JavaScript does not know is an Opaque');
  assert.match(bytesToHex((read['a'] as Opaque).bytes), /^7000/, 'the pattern is held as stored');
  const written = bytesToHex(encodeDocument(read));
  // The library keeps a regex's options sorted, so "xi" comes back as "ix": same regex, same
  // options, other order. The x flag must not be lost.
  assert.equal(written, '0d0000000b6100700069780000');
});

// What the documents promise about write-back must be what the tests show. Each of these is a value
// that changes on a read followed by a write, and each is named where a reader will look.
test('the README and the codec header say exactly what write-back changes', () => {
  const readme = readFileSync('README.md', 'utf8');
  const section = readme.slice(readme.indexOf('## BSON values'), readme.indexOf('## Things worth knowing'));
  assert.ok(section.length > 100, 'found the "BSON values" section');
  assert.match(section, /symbol[^.]*string/i, 'a symbol is read, and written back, as a string');
  assert.match(section, /options[^.]*sorted/i, 'regex options are stored sorted');
  assert.match(section, /"xi"[^.]*"ix"/, 'the example: stored "xi" is written back as "ix"');
  assert.match(section, /3\.0[^.]*int32/, 'a whole-valued double is written back as an int32');
  assert.doesNotMatch(section, /regex[^|\n]*(byte for byte|exactly as it was read)/i, 'no promise of an exact regex');
  assert.match(section, /dbPointer/, 'the refusals are named');

  const header = readFileSync('src/codec/values.ts', 'utf8').split('\n').slice(0, 14).join('\n');
  assert.match(header, /options[^.]*sorted/i, 'the header says regex options are stored sorted');
  assert.match(header, /symbol/i, 'the header names the symbol');
  assert.match(header, /int32/, 'the header names the whole-valued double');
  assert.doesNotMatch(header, /regex survives a read and a write byte for byte/, 'the header no longer says that');
});

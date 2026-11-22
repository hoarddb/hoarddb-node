// SPDX-License-Identifier: Apache-2.0
//
// The nesting limit of 100 (the root document is depth 1), the same on the way in as the server
// holds it. The corpus replays the two depths it holds (101 and 1000); this pins the edge and the
// depths past what the library can recurse.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { decodeDocument, encodeDocument } from '../../src/codec/index.js';
import { InvalidArgumentError } from '../../src/errors.js';

/** A document of `levels` levels in all (the root is 1), built without recursion, as bytes. */
function nestedBytes(levels: number): Uint8Array {
  let inner = Buffer.from([5, 0, 0, 0, 0]);
  for (let level = 1; level < levels; level += 1) {
    const wrapped = Buffer.alloc(4 + 1 + 2 + inner.length + 1);
    wrapped.writeInt32LE(wrapped.length, 0);
    wrapped[4] = 0x03;
    wrapped[5] = 0x61;
    inner.copy(wrapped, 7);
    inner = wrapped;
  }
  return inner;
}

test('a document nested 100 levels deep is read, 101 is refused', () => {
  assert.doesNotThrow(() => decodeDocument(nestedBytes(100), 'safe'));
  assert.throws(() => decodeDocument(nestedBytes(101), 'safe'), /nested deeper than 100 levels/);
});

test('a document nested past what the library can recurse is refused in words, not with a stack overflow', () => {
  for (const levels of [5_000, 200_000]) {
    assert.throws(
      () => decodeDocument(nestedBytes(levels), 'safe'),
      (error: unknown) => error instanceof Error && !(error instanceof RangeError) && /nested deeper than 100 levels/.test(error.message),
    );
  }
});

/** A plain object of `levels` levels in all, the root being 1. */
function nestedValue(levels: number): Record<string, unknown> {
  let value: Record<string, unknown> = {};
  for (let level = 1; level < levels; level += 1) value = { a: value };
  return value;
}

test('a value nested 100 levels deep is written, 101 is refused before any byte, as InvalidArgumentError', () => {
  assert.doesNotThrow(() => encodeDocument(nestedValue(100)));
  assert.throws(
    () => encodeDocument(nestedValue(101)),
    (error: unknown) => error instanceof InvalidArgumentError && /nested deeper than 100 levels/.test(error.message),
  );
  assert.throws(
    () => encodeDocument(nestedValue(50_000)),
    (error: unknown) => error instanceof InvalidArgumentError,
  );
  assert.throws(() => encodeDocument({ list: nestedArrays(101) }), InvalidArgumentError);
});

function nestedArrays(levels: number): unknown[] {
  let value: unknown[] = [];
  for (let level = 1; level < levels; level += 1) value = [value];
  return value;
}

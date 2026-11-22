// SPDX-License-Identifier: Apache-2.0

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { loadDriverVectors, loadUriVectors } from '../helpers/vectors.js';
import { DRIVER_VERSION } from '../../src/version.js';

test('driver vectors load and have the expected format', () => {
  const vectors = loadDriverVectors();
  assert.equal(vectors.format, 'hoarddb-driver-vectors/1');
  assert.ok(
    vectors.vectors.length >= 188,
    `expected at least 188 driver vectors, found ${vectors.vectors.length}`,
  );
});

test('uri vectors load', () => {
  const vectors = loadUriVectors();
  assert.equal(vectors.cases.length, 19, `expected 19 uri cases, found ${vectors.cases.length}`);
  assert.equal(
    vectors.invalid.length,
    29,
    `expected 29 refused uris, found ${vectors.invalid.length}`,
  );
});

test('DRIVER_VERSION matches package.json', () => {
  const manifest = JSON.parse(readFileSync('package.json', 'utf8')) as { version: string };
  assert.equal(DRIVER_VERSION, manifest.version);
});

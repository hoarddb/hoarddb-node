// SPDX-License-Identifier: Apache-2.0
//
// How a vector answer is compared: canonical Extended JSON in, a comparable tree out. The server
// encodes a stored document and every map it is given in an order that differs run to run, and it
// writes an integer in int32 or int64 depending on what it was given, so nothing is ever compared
// by bytes: the values are normalised and compared field by field (handbook testing.md section 1).

import assert from 'node:assert/strict';

function isTree(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Canonical Extended JSON → a comparable tree: {$numberInt}/{$numberLong} → {"$int": "<digits>"}; object keys sorted; arrays kept. */
export function normalise(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalise);
  if (!isTree(value)) return value;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    const entry = value[key];
    // One number on the wire, two names in Extended JSON: the width is not part of the value.
    if ((key === '$numberInt' || key === '$numberLong') && typeof entry === 'string') {
      sorted['$int'] = entry;
      continue;
    }
    sorted[key] = normalise(entry);
  }
  return sorted;
}

/** The BSON type of a canonical Extended JSON value: 'string'|'bool'|'null'|'int'|'double'|'date'|'binary'|'oid'|'decimal'|'array'|'object'|'other'. int32 and int64 are both 'int'. */
export function bsonTypeOf(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (!isTree(value)) {
    if (typeof value === 'number') return 'double';
    if (typeof value === 'boolean') return 'bool';
    return typeof value;
  }
  const type = value as Record<string, unknown>;
  if ('$numberInt' in type || '$numberLong' in type) return 'int';
  if ('$numberDouble' in type) return 'double';
  if ('$date' in type) return 'date';
  if ('$binary' in type) return 'binary';
  if ('$oid' in type) return 'oid';
  if ('$numberDecimal' in type) return 'decimal';
  if ('$timestamp' in type) return 'timestamp';
  const keys = Object.keys(type);
  if (keys.length === 1 && (keys[0] as string).startsWith('$')) return 'other';
  return 'object';
}

/** Delete a vary path ("seq", "data._id_", "nodes[].joinedat") from a tree, returning the removed values (one per array element). */
export function removePath(tree: unknown, path: string): unknown[] {
  const removed: unknown[] = [];
  take(tree, path.split('.'), 0, removed);
  return removed;
}

function take(node: unknown, segments: readonly string[], index: number, removed: unknown[]): void {
  const segment = segments[index];
  if (segment === undefined || (!Array.isArray(node) && !isTree(node))) return;
  // An array in the middle of a path means every element of it, whether or not the path wrote [].
  if (Array.isArray(node)) {
    for (const entry of node) take(entry, segments, index, removed);
    return;
  }
  const everyElement = segment.endsWith('[]');
  const key = everyElement ? segment.slice(0, -2) : segment;
  if (!Object.hasOwn(node, key)) return;
  const child = node[key];
  if (index !== segments.length - 1) {
    take(child, segments, index + 1, removed);
    return;
  }
  if (everyElement) {
    if (Array.isArray(child) && child.every((entry) => !isTree(entry))) {
      // An array of scalars (item_ids[]): every element varies, so all of them leave the tree.
      removed.push(...child);
      node[key] = [];
    } else if (Array.isArray(child)) {
      for (const entry of child) removed.push(isTree(entry) ? entry[key] : undefined);
    }
    return;
  }
  removed.push(child);
  delete node[key];
}

/** assert.deepStrictEqual(normalise(actual), normalise(expected)) after removing every vary path from both, having first asserted each vary path is present in actual with the same bsonTypeOf as in expected. */
export function assertResponseMatches(
  actual: unknown,
  expected: unknown,
  vary: readonly string[],
): void {
  const answer = structuredClone(actual);
  const documented = structuredClone(expected);
  for (const path of vary) {
    const found = removePath(answer, path);
    const wanted = removePath(documented, path);
    assert.ok(found.length > 0, `the varying field "${path}" is absent from the answer`);
    assert.equal(
      found.length,
      wanted.length,
      `the varying field "${path}" is in the answer ${found.length} time(s), in the vector ${wanted.length}`,
    );
    found.forEach((entry, position) => {
      assert.equal(
        bsonTypeOf(entry),
        bsonTypeOf(wanted[position]),
        `the varying field "${path}" is ${bsonTypeOf(wanted[position])} in the vector and ${bsonTypeOf(entry)} in the answer`,
      );
    });
  }
  assert.deepEqual(normalise(answer), normalise(documented));
}

/**
 * A request value as a comparable tree that keeps the integer width: {$numberInt} and {$numberLong}
 * stay distinct, because a request is the driver's own encoding and a vector that pins int64 (a heap
 * priority, expect_bucket_id) must not be met by an int32. Keys sorted, arrays kept. Responses are
 * compared without the width (normalise): there the server chooses it.
 */
export function normaliseRequest(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normaliseRequest);
  if (!isTree(value)) return value;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) sorted[key] = normaliseRequest(value[key]);
  return sorted;
}

/** Request check (testing.md §1.1): every key of actual is in allowed; every key of expected is in actual with an equal value, integer width included (normaliseRequest), except that an expected empty value ("", null, 0, false, [], {}) may be absent. */
export function assertRequestMatches(
  actual: Record<string, unknown>,
  expected: Record<string, unknown>,
  allowed: readonly string[],
): void {
  for (const key of Object.keys(actual)) {
    assert.ok(
      allowed.includes(key),
      `the request carries "${key}", which this operation has no field for; it may carry ${allowed.join(', ')}`,
    );
  }
  for (const [key, wanted] of Object.entries(expected)) {
    // The server's own encoder writes some empty fields a driver is free to leave out.
    if (isEmpty(wanted) && !Object.hasOwn(actual, key)) continue;
    assert.ok(Object.hasOwn(actual, key), `the request does not carry "${key}"`);
    assert.deepEqual(normaliseRequest(actual[key]), normaliseRequest(wanted), `the request field "${key}" differs`);
  }
}

function isEmpty(value: unknown): boolean {
  if (value === '' || value === null || value === 0 || value === false) return true;
  if (Array.isArray(value)) return value.length === 0;
  return isTree(value) && Object.keys(value).length === 0;
}
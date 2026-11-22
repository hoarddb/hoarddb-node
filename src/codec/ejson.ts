// SPDX-License-Identifier: Apache-2.0
//
// Extended JSON, the form the frozen vectors are written in. Nothing on the wire uses this: the
// server and this driver exchange BSON. It exists so a test, and the replay harness, can hold a
// payload as text and compare it field by field (handbook testing.md section 1).

import { EJSON, deserialize, serialize } from 'bson';

import { decodeDocument, type Int64Mode } from './raw.js';

const CANONICAL_OPTIONS = { relaxed: false } as const;
const EJOUTON_BYTES_OPTIONS = { promoteValues: false, promoteBuffers: false, bsonRegExp: true } as const;

/** Canonical Extended JSON (v2) → BSON bytes, exactly as given. */
export function bytesFromExtendedJson(value: unknown): Uint8Array {
  return serialize(EJSON.deserialize(value as Record<string, unknown>, CANONICAL_OPTIONS));
}

/** BSON bytes → canonical Extended JSON. */
export function extendedJsonFromBytes(bytes: Uint8Array): Record<string, unknown> {
  const tree = EJSON.serialize(
    deserialize(bytes, EJOUTON_BYTES_OPTIONS),
    CANONICAL_OPTIONS,
  );
  return tree as Record<string, unknown>;
}

/** Canonical Extended JSON → driver JS values (EJSON → bytes → decodeDocument). */
export function valuesFromExtendedJson(value: unknown, mode: Int64Mode): Record<string, unknown> {
  return decodeDocument(bytesFromExtendedJson(value), mode);
}
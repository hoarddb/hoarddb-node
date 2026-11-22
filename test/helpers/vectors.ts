// SPDX-License-Identifier: Apache-2.0
//
// The frozen vectors are the shared wire contract: testdata/ is synced from the hoardDB
// repository and never edited here. The path is relative to the working directory, because
// npm runs every script with the package as its directory.

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export interface DriverVectors {
  format: string;
  server_commit: string;
  server_env: Record<string, string>;
  normalisations: string[];
  vectors: Vector[];
}

export interface Vector {
  name: string;
  group: string;
  kind: 'frame' | 'exchange' | 'decode' | 'trust';
  status: string;
  [key: string]: unknown;
}

export interface UriVectors {
  defaults: { scheme: string; port: number; dialTimeoutMs: number };
  cases: { name: string; uri: string; expect: unknown }[];
  invalid: { name: string; uri: string; error_contains: string; error_excludes?: string[] }[];
}

/** One line of testdata/bson-vectors/v1.json; the fields a kind uses are named in the file's own `kinds` glossary. */
export interface BsonVector {
  name: string;
  group: string;
  kind: 'encode' | 'decode' | 'reject' | 'encode_refuse' | 'datetime_floor' | 'size';
  notes?: string;
  document?: unknown;
  hex?: string;
  reencodes_identically?: boolean;
  last_wins_document?: unknown;
  refusal?: string;
  reason?: string;
  server_decoder?: string;
  instant?: string;
  expected_millis?: string;
  recipe?: { key: string; fill: string; fill_bytes: number };
  document_bytes?: number;
  sha256?: string;
  fits_one_frame?: boolean;
  within_default_document_limit?: boolean;
}

export interface BsonVectors {
  format: string;
  limits: { max_depth: number; frame_payload_max_bytes: number; default_document_limit_bytes: number };
  value_forms: Record<string, string>;
  kinds: Record<string, string>;
  vectors: BsonVector[];
}

const VECTOR_PATHS = ['testdata'];

function readVectorsFile(relativePath: string): string {
  for (const base of VECTOR_PATHS) {
    const candidate = resolve(process.cwd(), base, relativePath);
    if (existsSync(candidate)) return readFileSync(candidate, 'utf8');
  }
  throw new Error(
    `vectors file "${relativePath}" not found: looked in ${VECTOR_PATHS.map(
      (base) => resolve(process.cwd(), base, relativePath),
    ).join(' and ')}`,
  );
}

export function loadDriverVectors(): DriverVectors {
  return JSON.parse(readVectorsFile('driver-vectors/v1.json')) as DriverVectors;
}

export function loadUriVectors(): UriVectors {
  return JSON.parse(readVectorsFile('uri-vectors/v1.json')) as UriVectors;
}

export function loadBsonVectors(): BsonVectors {
  return JSON.parse(readVectorsFile('bson-vectors/v1.json')) as BsonVectors;
}

export function vectorsOfKind(kind: Vector['kind']): Vector[] {
  return loadDriverVectors().vectors.filter((vector) => vector.kind === kind);
}

export function vectorNamed(name: string): Vector {
  const vectors = loadDriverVectors().vectors;
  const named = vectors.filter((vector) => vector.name === name);
  if (named.length === 0) {
    throw new Error(`no vector named "${name}": the file holds ${vectors.length} vectors`);
  }
  return named[0] as Vector;
}

export function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) {
    throw new Error(`hex string of odd length (${hex.length} characters)`);
  }
  const bytes = new Uint8Array(hex.length / 2);
  for (let offset = 0; offset < bytes.length; offset += 1) {
    const byte = Number.parseInt(hex.slice(offset * 2, offset * 2 + 2), 16);
    if (Number.isNaN(byte)) {
      throw new Error(`hex string is not hexadecimal at offset ${offset * 2}`);
    }
    bytes[offset] = byte;
  }
  return bytes;
}

export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

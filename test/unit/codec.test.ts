// SPDX-License-Identifier: Apache-2.0
//
// The codec seam, pinned by the frozen vectors. The bson edge document decodes to the documented
// JavaScript values, a value with no JavaScript form is written back byte for byte, and what the
// driver refuses to encode it refuses by name. Comparison is by value and BSON type, never by
// bytes: the server orders the fields of a document its own way (handbook testing.md section 1).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';

import {
  bytesFromExtendedJson,
  decodeDocument,
  encodeDocument,
  extendedJsonFromBytes,
  isOpaque,
  toWire,
  valuesFromExtendedJson,
} from '../../src/codec/index.js';
import { FrameTooLargeError, InvalidArgumentError } from '../../src/errors.js';
import { MAX_LENGTH } from '../../src/wire/frame.js';
import { assertResponseMatches, normalise } from '../helpers/compare.js';
import {
  bytesToHex,
  hexToBytes,
  vectorNamed,
  vectorsOfKind,
  type Vector,
} from '../helpers/vectors.js';

const EDGE_VECTOR = 'bson edge values round trip';

/** The stored document of the bson edge vector, decoded the way a caller reads it. */
function edgeData(): Record<string, unknown> {
  const response = vectorNamed(EDGE_VECTOR).response as { payload_hex: string };
  return decodeDocument(hexToBytes(response.payload_hex), 'safe')['data'] as Record<string, unknown>;
}

function edgeVectorData(): Record<string, unknown> {
  const response = vectorNamed(EDGE_VECTOR).response as { payload_json: { data: unknown } };
  return response.payload_json.data as Record<string, unknown>;
}

function refusalNaming(path: string) {
  return (error: unknown): boolean => {
    assert.ok(error instanceof InvalidArgumentError, `expected an InvalidArgumentError, got ${String(error)}`);
    assert.ok(
      error.message.includes(`field "${path}"`),
      `the refusal does not name the field: ${error.message}`,
    );
    return true;
  };
}

test('the bson edge vector decodes to the documented JS values', () => {
  const edge = edgeData();
  assert.ok(edge['At'] instanceof Date, 'At is a Date');
  assert.equal((edge['At'] as Date).getTime(), 1791203696789);
  assert.equal(edge['I32'], 2147483647);
  assert.equal(edge['I64'], 9007199254740993n);
  assert.equal(edge['Double'], 1.5);
  assert.deepEqual(edge['Generic'], new Uint8Array([0, 1, 254, 255]));
  for (const [field, bsonType] of [
    ['UUID', 'binary'],
    ['Oid', 'objectId'],
    ['Dec', 'decimal128'],
  ] as const) {
    const stored = edge[field];
    assert.ok(isOpaque(stored), `${field} is not an Opaque`);
    assert.equal(stored.bsonType, bsonType);
  }
  assert.deepEqual(edge['Nested'], { Deep: { Value: true } });
});

test('an Opaque writes back byte for byte', () => {
  const written = extendedJsonFromBytes(encodeDocument(edgeData()));
  const documented = edgeVectorData();
  // The one difference the codec documents: a stored double with an integral value comes back as
  // the number 3 and is written again as an int32. That is BSON to JavaScript, not a lost value.
  assert.notDeepEqual(normalise(written), normalise(documented));
  const expected = structuredClone(documented) as { List: unknown[] };
  expected.List[2] = { $numberInt: '3' };
  assert.deepEqual(normalise(written), normalise(expected));
});

test('int64 mode bigint returns bigint even for small values', () => {
  const encoded = encodeDocument({ small: 5n, large: 9007199254740993n });
  const read = decodeDocument(encoded, 'bigint');
  assert.equal(read['small'], 5n);
  assert.equal(read['large'], 9007199254740993n);
});

test('int64 mode safe returns number for safe values', () => {
  const read = valuesFromExtendedJson(
    { small: { $numberLong: '5' }, large: { $numberLong: '9007199254740993' } },
    'safe',
  );
  assert.equal(read['small'], 5);
  assert.equal(read['large'], 9007199254740993n);
});

test('a Uint8Array is written as binary subtype 0', () => {
  const encoded = encodeDocument({ blob: new Uint8Array([0, 1, 254, 255]) });
  assert.deepEqual(extendedJsonFromBytes(encoded), {
    blob: { $binary: { base64: 'AAH+/w==', subType: '00' } },
  });
  assert.deepEqual(decodeDocument(encoded, 'safe')['blob'], new Uint8Array([0, 1, 254, 255]));
});

test('undefined fields are dropped', () => {
  const encoded = encodeDocument({ kept: 1, dropped: undefined, nested: { alsoDropped: undefined } });
  assert.deepEqual(extendedJsonFromBytes(encoded), { kept: { $numberInt: '1' }, nested: {} });
});

test('a Map, a class instance and a function are refused naming the path', () => {
  class Point {
    constructor(readonly x: number) {}
  }
  assert.throws(() => toWire({ a: { b: new Map() } }), refusalNaming('a.b'));
  assert.throws(() => toWire({ a: { b: new Point(1) } }), refusalNaming('a.b'));
  assert.throws(() => toWire({ a: { b: () => 1 } }), (error: unknown) => {
    assert.ok(error instanceof InvalidArgumentError);
    assert.equal(
      error.message,
      'field "a.b" holds a function; hoardDB stores strings, numbers, bigints, booleans, null, ' +
        'Dates, Uint8Arrays, arrays and plain objects',
    );
    return true;
  });
});

test('a hand-made object shaped like an Opaque is a plain object', () => {
  const encoded = encodeDocument({ d: { bsonType: 'decimal128', bytes: new Uint8Array(16) } });
  const written = extendedJsonFromBytes(encoded);
  const asDocument = written['d'] as Record<string, unknown>;
  assert.equal(asDocument['$numberDecimal'], undefined, 'it was written as a decimal');
  assert.equal(asDocument['bsonType'], 'decimal128');
  const binary = asDocument['bytes'] as unknown as { $binary: { base64: string; subType: string } };
  assert.equal(binary.$binary.subType, '00');
  assert.deepEqual(Array.from(Buffer.from(binary.$binary.base64, 'base64')), new Array(16).fill(0));
});

test('extendedJsonFromBytes of every exchange response payload_hex matches payload_json', () => {
  const exchanges = vectorsOfKind('exchange') as Vector[];
  const withAnswer = exchanges.filter(
    (vector) => (vector['response'] as { payload_json?: unknown } | undefined)?.payload_json !== undefined,
  );
  assert.ok(withAnswer.length >= 150, `only ${withAnswer.length} exchange answers found`);
  for (const vector of withAnswer) {
    const response = vector['response'] as { payload_hex: string; payload_json: unknown };
    assertResponseMatches(
      extendedJsonFromBytes(hexToBytes(response.payload_hex)),
      response.payload_json,
      [],
    );
  }
});

test('bytesFromExtendedJson reproduces the server request bytes for the put vector', () => {
  const request = vectorNamed('put on a hash bucket').request as { payload_json: unknown; payload_hex: string };
  assert.equal(bytesToHex(bytesFromExtendedJson(request.payload_json)), request.payload_hex);
});
/** A {data: <binary subtype 0>} document is its bytes plus 16: length, type, "data", binary header, end. */
const BINARY_DOC_OVERHEAD = 16;
const MIB = 1024 * 1024;

test('a 20 MiB document encodes and decodes', () => {
  const data = new Uint8Array(20 * MIB);
  data[0] = 7;
  data[data.length - 1] = 9;
  const encoded = encodeDocument({ data });
  assert.equal(encoded.length, data.length + BINARY_DOC_OVERHEAD);
  const decoded = decodeDocument(encoded, 'safe')['data'];
  assert.ok(decoded instanceof Uint8Array, 'a binary subtype 0 reads back as a Uint8Array');
  assert.equal(decoded.length, data.length);
  assert.equal(decoded[0], 7);
  assert.equal(decoded[decoded.length - 1], 9);
});

test('a document over the frame limit is refused with its real byte count, unwritten', () => {
  assert.throws(
    () => encodeDocument({ data: new Uint8Array(MAX_LENGTH) }),
    (error: FrameTooLargeError) => {
      // The codec's own refusal is already the class and code a program sees, so a caller that
      // encodes without call() cannot hand out anything else.
      assert.ok(error instanceof FrameTooLargeError, `expected FrameTooLargeError, got ${String(error)}`);
      assert.equal(error.code, 'FRAME_TOO_LARGE');
      assert.equal(error.encodedBytes, MAX_LENGTH + BINARY_DOC_OVERHEAD, 'the size bson computes, not a guess');
      assert.equal(
        error.message,
        `This request encodes to ${MAX_LENGTH + BINARY_DOC_OVERHEAD} bytes; a frame holds at most ${MAX_LENGTH} (1 + 16 + payload ≤ 32 MiB). Nothing was sent. Split it into smaller batches, or store a large value as a blob.`,
      );
      return true;
    },
  );
  assert.equal(encodeDocument({ kept: 1 }).length, 15, 'a small document still encodes afterwards');
});

/** A full collection, so the transient copies a conversion makes are gone before memory is read. */
function collectGarbage(): void {
  setFlagsFromString('--expose-gc');
  (runInNewContext('gc') as () => void)();
}

test('a refused oversized document leaves resident memory where it was', async () => {
  // The copies toWire makes are collected before measuring. What stays is the encoder's: bson's buffer
  // only grows (measured with 7.3.3), so writing a 128 MiB document to learn its size kept a 128 MiB
  // buffer alive for the life of the process. Measured as the memory held by ArrayBuffers, which is
  // that buffer exactly, after a collection, a pause and a second collection: a freed backing store is
  // released a little after the collection that frees it (on Node 22 and 26 alike, about a frame's
  // worth stays counted right after it), and process rss also counts pages the allocator keeps (N-62).
  const data = new Uint8Array(128 * MIB);
  collectGarbage();
  const before = process.memoryUsage().arrayBuffers;
  assert.throws(() => encodeDocument({ data }), FrameTooLargeError);
  collectGarbage();
  await new Promise((resolveWait) => setTimeout(resolveWait, 300));
  collectGarbage();
  const grownBytes = process.memoryUsage().arrayBuffers - before;
  assert.ok(grownBytes < 64 * MIB, `refusing a 128 MiB document kept ${grownBytes} bytes of buffers alive`);
});

// SPDX-License-Identifier: Apache-2.0
//
// The BSON byte corpus (testdata/bson-vectors/v1.json), replayed through the driver's own codec. The
// handbook (testing.md section 1.3) says a driver that uses a BSON library does not need this file;
// it is replayed anyway, as information about where the library stops short of the spec. Only
// src/codec/index.ts is used: the codec seam (scripts/lint.mjs, rule codec-seam) keeps the library out
// of tests, and a test that named it would test the library and not the driver.
//
// A vector the codec cannot honour is never skipped and never edited. It is named in the table of
// known differences (test/unit/bson-known-differences.json, one table per check) with a verdict and the
// reason, and its test fails if the codec ever starts to agree,
// so the table cannot go stale.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  bytesFromExtendedJson,
  decodeDocument,
  encodeDocument,
  extendedJsonFromBytes,
} from '../../src/codec/index.js';
import { InvalidArgumentError } from '../../src/errors.js';
import { FrameError, encodeFrameHeader } from '../../src/wire/frame.js';
import { orderedText, typedToExtendedJson, typedToPlainValue } from '../helpers/typed-bson.js';
import {
  bytesToHex,
  hexToBytes,
  loadBsonVectors,
  type BsonVector,
} from '../helpers/vectors.js';

type Kind = BsonVector['kind'];

/** One entry of bson-known-differences.json: a vector the codec does not honour, and why. */
interface KnownDifference {
  verdict: 'deliberate' | 'acceptable';
  node: string;
  corpus: string;
  reason: string;
}

/** Vector name → the known difference. Every entry is a decision of the owner, listed once, with a reason. */
type KnownDifferences = ReadonlyMap<string, KnownDifference>;

/** One check over the vectors of one kind; a kind can have more than one, each with its own table. */
type Check = 'encode' | 'encode-roundtrip' | 'decode' | 'reject' | 'encode_refuse' | 'datetime_floor' | 'size';

/** The table is data, not code, so it can be read without running the test (README, conformance section). */
function loadKnownDifferences(): Record<Check, KnownDifferences> {
  const text = readFileSync(resolve(process.cwd(), 'test/unit/bson-known-differences.json'), 'utf8');
  const file = JSON.parse(text) as Record<string, unknown>;
  const checks: Check[] = ['encode', 'encode-roundtrip', 'decode', 'reject', 'encode_refuse', 'datetime_floor', 'size'];
  const loaded = {} as Record<Check, KnownDifferences>;
  for (const check of checks) {
    const entries = Object.entries(file[check] as Record<string, KnownDifference>);
    for (const [name, entry] of entries) {
      assert.ok(entry.reason.length > 0 && entry.node.length > 0 && entry.corpus.length > 0, `${name}: an entry needs node, corpus and reason`);
    }
    loaded[check] = new Map(entries);
  }
  return loaded;
}

const KNOWN_DIFFERENCES = loadKnownDifferences();

const corpus = loadBsonVectors();

function vectorsOf(kind: Kind): BsonVector[] {
  return corpus.vectors.filter((vector) => vector.kind === kind);
}

interface Outcome {
  total: number;
  passed: number;
  known: string[];
  failed: string[];
}

/** The first byte at which two hex strings differ, so a mismatch on a 30 MiB document stays readable. */
function firstDifference(actual: string, expected: string): string {
  const shared = Math.min(actual.length, expected.length);
  let at = 0;
  while (at < shared && actual[at] === expected[at]) at += 1;
  return `the bytes differ at offset ${Math.floor(at / 2)} (${actual.length / 2} bytes written, ${expected.length / 2} expected)`;
}

/**
 * Run one check over every vector of a kind. A vector in the known differences must still disagree;
 * any other vector that disagrees is a failure, listed by name.
 */
function replay(label: Check, kind: Kind, check: (vector: BsonVector) => void, vectors = vectorsOf(kind)): Outcome {
  const known = KNOWN_DIFFERENCES[label];
  const names = new Set(vectors.map((vector) => vector.name));
  for (const name of known.keys()) {
    assert.ok(names.has(name), `the known difference "${name}" names no ${kind} vector in scope for ${label}`);
  }

  const outcome: Outcome = { total: vectors.length, passed: 0, known: [], failed: [] };
  for (const vector of vectors) {
    let disagreement: string | undefined;
    try {
      check(vector);
    } catch (error) {
      disagreement = (error as Error).message;
    }
    if (known.has(vector.name)) {
      if (disagreement === undefined) {
        outcome.failed.push(`${vector.name}: listed as a known difference but the codec now agrees; remove the entry`);
      } else {
        outcome.known.push(vector.name);
      }
    } else if (disagreement === undefined) {
      outcome.passed += 1;
    } else {
      outcome.failed.push(`${vector.name}: ${disagreement}`);
    }
  }
  return outcome;
}

function conclude(label: Check, kind: Kind, outcome: Outcome, ofKind = vectorsOf(kind).length): void {
  process.stdout.write(
    `bson corpus ${label}: ${outcome.total} of ${ofKind} ${kind} vectors, ${outcome.passed} passed, ${outcome.known.length} known differences, ${outcome.failed.length} failed\n`,
  );
  assert.ok(outcome.total > 0, `the corpus holds no ${kind} vectors for ${label}`);
  assert.equal(
    outcome.passed + outcome.known.length + outcome.failed.length,
    outcome.total,
    `every ${label} vector is passed, a known difference or failed`,
  );
  assert.deepEqual(outcome.failed, [], `${outcome.failed.length} of ${outcome.total} ${label} vectors fail:\n${outcome.failed.join('\n')}`);
}

function hexOf(vector: BsonVector): string {
  assert.ok(vector.hex !== undefined, `${vector.name}: the vector has no hex`);
  return vector.hex;
}

function checkEncode(vector: BsonVector): void {
  const wanted = typedToExtendedJson(vector.document);
  const expectedHex = hexOf(vector);

  const written = bytesToHex(bytesFromExtendedJson(wanted));
  assert.equal(written === expectedHex, true, `writing the document gave other bytes: ${firstDifference(written, expectedHex)}`);

  const bytes = hexToBytes(expectedHex);
  decodeDocument(bytes, 'safe');
  assert.equal(orderedText(extendedJsonFromBytes(bytes)), orderedText(wanted), 'reading the bytes did not give the document back');
}

/** The driver's own pass-through: what a program that reads a document and writes it back sends. */
function throughValues(bytes: Uint8Array): string {
  return bytesToHex(encodeDocument(decodeDocument(bytes, 'bigint')));
}

function checkDecode(vector: BsonVector): void {
  const bytes = hexToBytes(hexOf(vector));
  decodeDocument(bytes, 'safe');

  // A decoder that returns a mapping keeps the last of a repeated key, in the position of the first.
  const wanted = typedToExtendedJson(vector.last_wins_document ?? vector.document);
  assert.equal(orderedText(extendedJsonFromBytes(bytes)), orderedText(wanted), 'the bytes did not read as the document');

  const written = throughValues(bytes);
  assert.equal(
    written === vector.hex,
    vector.reencodes_identically,
    `reencodes_identically is ${String(vector.reencodes_identically)} but writing the decoded values ${written === vector.hex ? 'gave the same bytes' : `changed them (${firstDifference(written, hexOf(vector))})`}`,
  );
}

/**
 * README, "BSON values": a value with no JavaScript form is an Opaque, "written back byte for byte",
 * and every other type (string, integer, boolean, null, Date, binary, array, document) has a form of
 * its own. So a document read and written back must keep its bytes. Doubles are the one group out of
 * scope: the same table says a whole double reads as a number and is written back as an int32.
 */
const OUT_OF_SCOPE_FOR_ROUNDTRIP: ReadonlyMap<string, string> = new Map([
  ['double', 'a whole double reads as a number and is written back as an int32 (README, BSON values)'],
]);

function checkEncodeRoundTrip(vector: BsonVector): void {
  const expectedHex = hexOf(vector);
  const written = throughValues(hexToBytes(expectedHex));
  assert.equal(written === expectedHex, true, `reading and writing the document changed its bytes: ${firstDifference(written, expectedHex)}`);
}

/** Any opcode: the frame encoder looks at the length, not at what the frame asks for. */
const REQUEST_OPCODE = 1;

const LANGUAGE_LEVEL = [TypeError, RangeError, ReferenceError, SyntaxError, EvalError, URIError];

/** Class names of what the codec raised, to say in the output what stands where the corpus names ProtocolError. */
const REFUSED_WITH = new Map<string, number>();

/**
 * The corpus names ProtocolError for every reject vector, and says to match on that and never on
 * `reason`. At the codec seam the refusal is the library's own error; call() turns any answer that
 * does not decode into ProtocolError (src/call.ts, "undecodable", tested in call.test.ts). What a
 * decoder must never do is raise a language-level exception, so that is what is checked here.
 */
function checkReject(vector: BsonVector): void {
  assert.equal(vector.refusal, 'ProtocolError', 'the corpus names another class than ProtocolError for this vector');
  let raised: unknown;
  try {
    decodeDocument(hexToBytes(vector.hex ?? ''), 'safe');
  } catch (error) {
    raised = error;
  }
  assert.ok(raised !== undefined, 'the bytes were accepted');
  assert.ok(raised instanceof Error, `the codec raised something that is not an Error: ${String(raised)}`);
  const language = LANGUAGE_LEVEL.find((kind) => raised instanceof kind);
  assert.equal(language, undefined, `the codec raised a language-level ${language?.name}: ${raised.message}`);
  REFUSED_WITH.set(raised.name, (REFUSED_WITH.get(raised.name) ?? 0) + 1);
}

test('encode vectors: the document writes to exactly the bytes and the bytes read back as the document', () => {
  conclude('encode', 'encode', replay('encode', 'encode', checkEncode));
});

test('encode vectors: a document read and written back by the driver keeps its bytes', () => {
  const all = vectorsOf('encode');
  const groups = new Set(all.map((vector) => vector.group));
  for (const group of OUT_OF_SCOPE_FOR_ROUNDTRIP.keys()) {
    assert.ok(groups.has(group), `the out-of-scope group "${group}" names no group of the file`);
  }
  const inScope = all.filter((vector) => !OUT_OF_SCOPE_FOR_ROUNDTRIP.has(vector.group));
  conclude('encode-roundtrip', 'encode', replay('encode-roundtrip', 'encode', checkEncodeRoundTrip, inScope), all.length);
});

test('decode vectors: the bytes are accepted, read as the document, and re-encode as the file says', () => {
  conclude('decode', 'decode', replay('decode', 'decode', checkDecode));
});

test('reject vectors: the codec refuses the bytes without a language-level exception or an allocation by the declared length', () => {
  const buffersBefore = process.memoryUsage().arrayBuffers;
  const outcome = replay('reject', 'reject', checkReject);
  const grewBy = process.memoryUsage().arrayBuffers - buffersBefore;

  const classes = [...REFUSED_WITH].map(([name, count]) => `${name} x${count}`).join(', ');
  process.stdout.write(`bson corpus reject: refused at the codec seam with ${classes}; the corpus names ProtocolError (call() wraps)\n`);
  conclude('reject', 'reject', outcome);
  assert.ok(grewBy < 64 * 1024 * 1024, `the reject vectors grew the array buffers by ${grewBy} bytes, as if allocating by a declared length`);
});

function raisedBy(work: () => unknown): unknown {
  try {
    work();
  } catch (error) {
    return error;
  }
  return undefined;
}

function encodeRefused(vector: BsonVector): unknown {
  return raisedBy(() => encodeDocument(typedToPlainValue(vector.document) as Record<string, unknown>));
}

function checkEncodeRefuse(vector: BsonVector): void {
  assert.equal(vector.refusal, 'InvalidArgumentError', 'the corpus names another class than InvalidArgumentError for this vector');
  const raised = encodeRefused(vector);
  assert.ok(raised !== undefined, 'the document was encoded');
  assert.ok(
    raised instanceof InvalidArgumentError,
    `the refusal is ${(raised as Error).name}, not InvalidArgumentError: ${(raised as Error).message.replaceAll('\0', '\\0')}`,
  );
}

test('encode_refuse vectors: the encoder refuses the document before it writes a byte', () => {
  const vectors = vectorsOf('encode_refuse');
  assert.ok(vectors.length > 0, 'the corpus holds no encode_refuse vectors');
  for (const vector of vectors) {
    const raised = encodeRefused(vector);
    assert.ok(raised instanceof Error, `${vector.name}: the document was encoded`);
    const language = LANGUAGE_LEVEL.find((kind) => raised instanceof kind);
    assert.equal(language, undefined, `${vector.name}: the encoder raised a language-level ${language?.name}`);
  }
});

test('encode_refuse vectors: the refusal is an InvalidArgumentError', () => {
  conclude('encode_refuse', 'encode_refuse', replay('encode_refuse', 'encode_refuse', checkEncodeRefuse));
});

/** A datetime: the instant read as a Date (which keeps milliseconds), written by the driver, and read back from the bytes. */
function checkDatetimeFloor(vector: BsonVector): void {
  const instant = vector.instant ?? '';
  const wanted = vector.expected_millis ?? '';

  const bytes = hexToBytes(hexOf(vector));
  const read = extendedJsonFromBytes(bytes) as { t: { $date: { $numberLong: string } } };
  assert.equal(read.t.$date.$numberLong, wanted, 'the bytes of the file do not hold expected_millis');

  const date = new Date(instant);
  assert.equal(String(date.getTime()), wanted, `the instant ${instant} reads as ${date.getTime()} ms, not ${wanted}`);
  const written = bytesToHex(encodeDocument({ t: date }));
  assert.equal(written === vector.hex, true, `writing the Date gave other bytes: ${firstDifference(written, hexOf(vector))}`);
}

test('datetime_floor vectors: sub-millisecond digits floor toward negative infinity', () => {
  conclude('datetime_floor', 'datetime_floor', replay('datetime_floor', 'datetime_floor', checkDatetimeFloor));
});

/** A document of one string field, built from the recipe, written by the driver, measured, and offered to the frame encoder. */
function checkSize(vector: BsonVector): void {
  const recipe = vector.recipe;
  assert.ok(recipe !== undefined, 'the vector has no recipe');
  assert.equal(recipe.fill.length, 1, 'the recipe fills with more than one character');
  assert.ok(recipe.fill.charCodeAt(0) < 0x80, 'the recipe fills with a character that is not one byte long');
  const document = { [recipe.key]: recipe.fill.repeat(recipe.fill_bytes) };

  // The codec writes whatever a frame's own length limit allows; whether the bytes may be sent is the
  // frame encoder's decision, so the document is measured first and then offered to it.
  const bytes = encodeDocument(document);
  assert.equal(bytes.length, vector.document_bytes, 'the document is another length than document_bytes');
  assert.equal(createHash('sha256').update(bytes).digest('hex'), vector.sha256, 'the document hashes to another SHA-256');

  const refusal = raisedBy(() => encodeFrameHeader(REQUEST_OPCODE, new Uint8Array(16), bytes.length));
  if (vector.fits_one_frame === true) {
    assert.equal(refusal, undefined, `fits_one_frame is true but the frame encoder refused the payload: ${String(refusal)}`);
  } else {
    assert.ok(refusal instanceof FrameError, `fits_one_frame is false but the frame encoder accepted ${bytes.length} bytes of payload`);
    assert.equal(refusal.refusal, 'length-too-large', 'the frame encoder refused for another reason');
  }
}

test('size vectors: the documents at and past the limits have the length and SHA-256 of the file, or are refused as too large for a frame', () => {
  conclude('size', 'size', replay('size', 'size', checkSize));
});

test('every vector of the file is of a kind this test replays, once', () => {
  const kinds = Object.keys(corpus.kinds).sort();
  assert.deepEqual(kinds, Object.keys(KNOWN_DIFFERENCES).filter((label) => label in corpus.kinds).sort(), 'a kind of the file has no replay here');
  const names = new Set<string>();
  let counted = 0;
  for (const kind of kinds) counted += vectorsOf(kind as Kind).length;
  for (const vector of corpus.vectors) {
    assert.ok(kinds.includes(vector.kind), `${vector.name}: the kind ${vector.kind} is not replayed`);
    assert.equal(names.has(vector.name), false, `${vector.name}: the name is used twice`);
    names.add(vector.name);
  }
  assert.equal(counted, corpus.vectors.length, 'the vectors of the replayed kinds are not all the vectors of the file');
  process.stdout.write(`bson corpus: ${corpus.vectors.length} vectors in ${kinds.length} kinds, every one replayed\n`);
});

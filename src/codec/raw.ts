// SPDX-License-Identifier: Apache-2.0
//
// The codec seam: the only file allowed to name bson. This file is the BSON in and out; the values
// that cross it, including the Opaque a value with no JavaScript form arrives as, are values.ts.
// Nothing here leaks a bson type outwards.

import { calculateObjectSize, deserialize, serialize, setInternalBufferSize } from 'bson';

import { FrameTooLargeError, UnreadableValueError } from '../errors.js';
import { MAX_LENGTH } from '../wire/frame.js';
import { attachRoot, depthExceeded, fromWire, toWire } from './values.js';

/** How an int64 that has no exact number form reaches the caller. */
export type Int64Mode = 'safe' | 'bigint';

const DECODE_OPTIONS = {
  promoteValues: true,
  promoteBuffers: false,
  useBigInt64: true,
  bsonRegExp: true,
} as const;

/** One BSON element: its type byte and its bytes, without the element's own header or name. */
const TYPE_OFFSET = 4;
const ELEMENT_START = 7;

const ENCODE_OPTIONS = { ignoreUndefined: true } as const;

/**
 * bson serializes into one process-wide buffer that is smaller than a frame by default, and throws a
 * RangeError, before the frame-size check can run, for any document that outgrows it. It is raised
 * once to the frame limit, so every legal payload encodes, and never touched again: bson's buffer
 * only grows (measured with 7.3.3: setting it back to 32 MiB after a 100 MiB document left 250 MB
 * resident), so writing an oversized document just to learn its size would keep that memory for the
 * life of the process. One buffer per process, never per client, bucket or store.
 */
let frameBufferSet = false;

/**
 * serialize, for any document a frame can carry. A document over the buffer is refused with
 * FrameTooLargeError from the size calculateObjectSize gives it, and is never written.
 */
function serializeWhole(doc: Record<string, unknown>, options?: typeof ENCODE_OPTIONS): Uint8Array {
  if (!frameBufferSet) {
    setInternalBufferSize(MAX_LENGTH);
    frameBufferSet = true;
  }
  try {
    return serialize(doc, options);
  } catch (error) {
    // Measured, not assumed: only a failed write pays for the size walk, so the hot path walks each
    // document once. Anything else that went wrong is rethrown as it was.
    const size = calculateObjectSize(doc, options);
    if (size <= MAX_LENGTH) throw error;
    // Already the class and code a program sees: a caller that encodes without call() cannot hand
    // out a bare Error instead. call() rewords it with the verb ("This put encodes to …").
    throw new FrameTooLargeError({
      message: `This request encodes to ${size} bytes; a frame holds at most ${MAX_LENGTH} (1 + 16 + payload ≤ 32 MiB). Nothing was sent. Split it into smaller batches, or store a large value as a blob.`,
      operation: 'encode',
      encodedBytes: size,
    });
  }
}

/** BSON bytes → a JS tree: deserialize with the options above, then fromWire (values.ts). */
export function decodeDocument(bytes: Uint8Array, mode: Int64Mode): Record<string, unknown> {
  // The bytes travel with the tree: bson builds the same DBRef for a dbPointer and for an embedded
  // {$ref, $id} document, and only the stored type byte tells them apart.
  let tree;
  try {
    tree = deserialize(bytes, DECODE_OPTIONS);
  } catch (error) {
    // The library recurses; bytes nested past what it can hold overflow its stack. That is the same
    // refusal as nesting past the limit, said in words and not as a language-level exception.
    if (error instanceof RangeError && /call stack/i.test(error.message)) throw depthExceeded();
    throw error;
  }
  try {
    return fromWire(tree, mode, { bytes }) as Record<string, unknown>;
  } catch (error) {
    // The tree is what names the document a refused value is in (its _id_), so it travels with the refusal.
    if (error instanceof UnreadableValueError) attachRoot(error, tree);
    throw error;
  }
}

/** A JS tree → BSON bytes: toWire (values.ts) then serialize(tree, { ignoreUndefined: true }). */
export function encodeDocument(doc: Record<string, unknown>): Uint8Array {
  return serializeWhole(toWire(doc), ENCODE_OPTIONS);
}

/** The one-field-document trick: serialize({ v: value }) and slice the element out of it. */
export function elementOf(value: unknown): { type: number; bytes: Uint8Array } {
  const doc = serializeWhole({ v: value });
  return {
    type: doc[TYPE_OFFSET]!,
    bytes: doc.subarray(ELEMENT_START, doc.length - 1),
  };
}

/** The reverse: [int32 total][type]['v' 0x00][bytes][0x00], read back without promoting values. */
export function valueFromElement(type: number, bytes: Uint8Array): unknown {
  const total = bytes.length + 8;
  const doc = new Uint8Array(total);
  new DataView(doc.buffer).setInt32(0, total, true);
  doc[TYPE_OFFSET] = type;
  doc[5] = 0x76;
  doc[6] = 0x00;
  doc.set(bytes, ELEMENT_START);
  doc[total - 1] = 0x00;
  // bsonRegExp: a regex must come back as bson's own BSONRegExp, whose pattern and options are
  // written as they are; a native RegExp rewrites an empty pattern as "(?:)" and drops options
  // JavaScript does not know, so an Opaque regex would not survive a write.
  return deserialize(doc, { promoteValues: false, bsonRegExp: true }).v;
}
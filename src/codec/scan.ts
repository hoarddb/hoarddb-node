// SPDX-License-Identifier: Apache-2.0
//
// Reads the type bytes of a BSON document without building any value. The library reads a genuine
// dbPointer (wire type 0c) as a DBRef, and an ordinary embedded document holding $ref and $id as a
// DBRef too; once built, the two are the same object, so the only thing that tells them apart is the
// type byte of the element in the bytes that were read. This walk finds where the type 0c elements
// are, and is run only for a document in which a DBRef turned up.

export type Segment = string | number;

/** A path as a map key: JSON keeps a key that contains a dot apart from a nested one. */
export function pathKey(segments: readonly Segment[]): string {
  return JSON.stringify(segments);
}

interface Frame {
  at: number;
  end: number;
  segments: readonly Segment[];
  isArray: boolean;
  ordinal: number;
}

const NAMES = new TextDecoder();

/**
 * The paths (as {@link pathKey}) of every element of wire type 0c in a document the library has
 * already read, so its structure is known to be sound. An array element's segment is its position,
 * as the value layer counts it, and not its key. Iterative: the codec reads documents nested a
 * thousand deep, and a walk that recursed would have a limit the library has not.
 */
export function dbPointerPaths(bytes: Uint8Array): Set<string> {
  const found = new Set<string>();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const stack: Frame[] = [{ at: 4, end: view.getInt32(0, true), segments: [], isArray: false, ordinal: 0 }];

  while (stack.length > 0) {
    const frame = stack[stack.length - 1] as Frame;
    // The last byte of a document is its terminator.
    if (frame.at >= frame.end - 1) {
      stack.pop();
      continue;
    }
    const type = bytes[frame.at] as number;
    let nameEnd = frame.at + 1;
    while (bytes[nameEnd] !== 0) nameEnd += 1;
    const name = NAMES.decode(bytes.subarray(frame.at + 1, nameEnd));
    let at = nameEnd + 1;
    const segments = [...frame.segments, frame.isArray ? frame.ordinal : name];
    frame.ordinal += 1;

    switch (type) {
      case 0x03:
      case 0x04: {
        const length = view.getInt32(at, true);
        frame.at = at + length;
        stack.push({ at: at + 4, end: at + length, segments, isArray: type === 0x04, ordinal: 0 });
        continue;
      }
      case 0x0c:
        found.add(pathKey(segments));
        at += 4 + view.getInt32(at, true) + 12;
        break;
      default: {
        const size = sizeOfValue(type, bytes, view, at);
        if (size === undefined) return found; // a type this walk does not know: stop, never guess
        at += size;
      }
    }
    frame.at = at;
  }
  return found;
}

/** The bytes a value of this type takes at `at`, or undefined for a type that is not known. */
function sizeOfValue(type: number, bytes: Uint8Array, view: DataView, at: number): number | undefined {
  switch (type) {
    case 0x01: // double
    case 0x09: // datetime
    case 0x11: // timestamp
    case 0x12: // int64
      return 8;
    case 0x02: // string
    case 0x0d: // javascript
    case 0x0e: // symbol
      return 4 + view.getInt32(at, true);
    case 0x05: // binary: length, subtype, payload
      return 4 + 1 + view.getInt32(at, true);
    case 0x06: // undefined
    case 0x0a: // null
    case 0x7f: // max key
    case 0xff: // min key
      return 0;
    case 0x07: // object id
      return 12;
    case 0x08: // boolean
      return 1;
    case 0x0b: {
      // regex: two cstrings
      let end = at;
      while (bytes[end] !== 0) end += 1;
      end += 1;
      while (bytes[end] !== 0) end += 1;
      return end + 1 - at;
    }
    case 0x0f: // javascript with scope: its length counts itself
      return view.getInt32(at, true);
    case 0x10: // int32
      return 4;
    case 0x13: // decimal128
      return 16;
    default:
      return undefined;
  }
}

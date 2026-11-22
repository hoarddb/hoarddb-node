// SPDX-License-Identifier: Apache-2.0
//
// Raw BSON by hand, for the values the driver refuses to write and so cannot be made with it: a
// datetime outside the Date range, a BSON undefined, a genuine dbPointer. Elements are byte arrays,
// documents are built from them.

const TEXT = new TextEncoder();

export function int32(value: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setInt32(0, value, true);
  return out;
}

export function join(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

export function cstring(text: string): Uint8Array {
  return join(TEXT.encode(text), new Uint8Array([0]));
}

/** A document from already-encoded elements. */
export function document(...elements: Uint8Array[]): Uint8Array {
  const body = join(...elements, new Uint8Array([0]));
  return join(int32(body.length + 4), body);
}

export function element(type: number, name: string, value: Uint8Array): Uint8Array {
  return join(new Uint8Array([type]), cstring(name), value);
}

export function string(text: string): Uint8Array {
  return join(int32(TEXT.encode(text).length + 1), cstring(text));
}

export function stringElement(name: string, text: string): Uint8Array {
  return element(0x02, name, string(text));
}

/** A genuine dbPointer element (wire type 0c): a namespace string and a 12-byte object id. */
export function dbPointer(name: string): Uint8Array {
  return element(0x0c, name, join(string('ns'), new Uint8Array(12).fill(0x11)));
}

/** A datetime element holding the largest int64, which no JavaScript Date can hold. */
export function outOfRangeDate(name: string): Uint8Array {
  return element(0x09, name, new Uint8Array([0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x7f]));
}

/** A BSON undefined element (wire type 06). */
export function bsonUndefined(name: string): Uint8Array {
  return element(0x06, name, new Uint8Array(0));
}

/** An ordinary embedded document {$ref, $id} (wire type 03), $id a string. */
export function embeddedRef(name: string, ref: string, id: string, ...more: Uint8Array[]): Uint8Array {
  return element(0x03, name, document(stringElement('$ref', ref), stringElement('$id', id), ...more));
}

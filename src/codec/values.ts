// SPDX-License-Identifier: Apache-2.0
//
// The values that cross the seam. Everything with a JavaScript form is itself; the values with none
// are the driver's own Opaque, which is recognised by WeakSet membership and never by shape, so a
// hand-made look-alike is written as the plain object it is. An Opaque is written back exactly as the
// driver holds it: a stored decimal, object id, timestamp, binary subtype, javascript, min or max key
// survives a read and a write byte for byte. A regex keeps its pattern and its options but not their
// order: the library stores a regex's options sorted, so options stored as "xi" are read, and written
// back, as "ix". A value that cannot be read faithfully (a datetime outside the Date range, a BSON
// undefined, a genuine dbPointer) is refused rather than altered. Two more things change on a read
// followed by a write, and are listed in the README ("BSON values"): a stored symbol reads as a string and
// is written back as a string, and a whole-valued double (3.0) reads as the number 3 and is written
// back as an int32.

import { DBRef } from 'bson';

import { InvalidArgumentError, UnreadableValueError, type UnreadableKind } from '../errors.js';
import { elementOf, valueFromElement, type Int64Mode } from './raw.js';
import { dbPointerPaths, pathKey, type Segment } from './scan.js';

/** A stored BSON value with no JavaScript form. Written back exactly as held (a regex's options are held sorted); not constructible in v1. */
export interface Opaque {
  readonly bsonType: OpaqueType;
  readonly bytes: Uint8Array;
}

export type OpaqueType =
  | 'binary'
  | 'objectId'
  | 'regex'
  | 'timestamp'
  | 'decimal128'
  | 'minKey'
  | 'maxKey'
  | 'javascript'
  | 'javascriptWithScope'
  | 'symbol'
  | 'dbPointer'
  | 'undefined';

const BINARY = 0x05;
const DOUBLE = 0x01;
const BINARY_SUBTYPE_AT = 4;
const BINARY_PAYLOAD_AT = 5;

/** Every BSON type byte that reaches a caller as an Opaque, and what the driver calls it. */
export const OPAQUE_TYPE_BY_BYTE: Readonly<Record<number, OpaqueType>> = {
  0x05: 'binary',
  0x06: 'undefined',
  0x07: 'objectId',
  0x0b: 'regex',
  0x0c: 'dbPointer',
  0x0d: 'javascript',
  0x0e: 'symbol',
  0x0f: 'javascriptWithScope',
  0x11: 'timestamp',
  0x13: 'decimal128',
  0x7f: 'maxKey',
  0xff: 'minKey',
};

/** The same table the other way, so writing an Opaque needs no lookup that can miss. */
const BYTE_BY_OPAQUE_TYPE: Readonly<Record<OpaqueType, number>> = {
  binary: 0x05,
  undefined: 0x06,
  objectId: 0x07,
  regex: 0x0b,
  dbPointer: 0x0c,
  javascript: 0x0d,
  symbol: 0x0e,
  javascriptWithScope: 0x0f,
  timestamp: 0x11,
  decimal128: 0x13,
  maxKey: 0x7f,
  minKey: 0xff,
};

const OPAQUES = new WeakSet<Opaque>();

/** A number that must be written as a BSON double even when it is whole (the operand of $mul). */
export interface WireDouble {
  readonly double: number;
}

const WIRE_DOUBLES = new WeakSet<WireDouble>();

/** Mark a number to be written as a double: bson writes a whole `number` as int32, and the server's $mul field is a double. */
export function asDouble(value: number): WireDouble {
  const wrapped: WireDouble = Object.freeze({ double: value });
  WIRE_DOUBLES.add(wrapped);
  return wrapped;
}

/** Whether a value is a WireDouble this driver made, by identity and never by its shape. */
export function isWireDouble(value: unknown): value is WireDouble {
  return WIRE_DOUBLES.has(value as WireDouble);
}

/** Wrap the bytes of a BSON element the driver has no JavaScript value for. */
export function makeOpaque(type: number, bytes: Uint8Array): Opaque {
  // The table is total over the type bytes this driver hands out; one that it does not name would
  // come from a BSON type this driver does not know, and the server is the one that writes those.
  const opaque: Opaque = Object.freeze({ bsonType: OPAQUE_TYPE_BY_BYTE[type]!, bytes });
  OPAQUES.add(opaque);
  return opaque;
}

/** Whether a value is an Opaque this driver made, by identity and never by its shape. */
export function isOpaque(value: unknown): value is Opaque {
  return OPAQUES.has(value as Opaque);
}

/** A JS tree → BSON bytes: toWire (values.ts) then serialize(tree, { ignoreUndefined: true }). */
export function toWire(doc: Record<string, unknown>, path = ''): Record<string, unknown> {
  return encode(doc, path, 1) as Record<string, unknown>;
}

/** What the value layer knows about the document it is reading, beyond the tree the library built. */
export interface ReadContext {
  /** The bytes the tree was read from: the only place a genuine dbPointer can be told from a document. */
  readonly bytes: Uint8Array;
  /** The paths of the type 0c elements of `bytes`, found the first time a DBRef is met. */
  genuineDbPointers?: Set<string>;
}

/**
 * BSON bytes → a JS tree: fromWire (values.ts) after the deserialize the caller asked for. `context`
 * is what lets a DBRef be told from a dbPointer; without it every DBRef is read as the embedded
 * document it was promoted from.
 */
export function fromWire(tree: unknown, mode: Int64Mode, context?: ReadContext): unknown {
  return walk(tree, mode, [], context);
}

/** The deepest nesting the server writes or reads: the root document is depth 1 (the corpus's limits.max_depth). */
export const MAX_DEPTH = 100;

/** An answer nested deeper than the server ever sends is not an answer from a sound peer; call() reports it as undecodable. */
export function depthExceeded(): Error {
  return new Error(`a document nested deeper than ${MAX_DEPTH} levels`);
}

function walk(tree: unknown, mode: Int64Mode, segments: readonly Segment[], context?: ReadContext): unknown {
  if (tree === undefined) refuseAt('undefined', segments);
  if (typeof tree === 'bigint') {
    const asNumber = Number(tree);
    return mode === 'safe' && Number.isSafeInteger(asNumber) ? asNumber : tree;
  }
  if (tree === null || typeof tree !== 'object') return tree;
  if (tree instanceof Date) {
    if (Number.isNaN(tree.getTime())) refuseAt('datetime', segments);
    return tree;
  }
  // A container here sits at depth segments.length + 1, the root being 1.
  if (segments.length >= MAX_DEPTH && (Array.isArray(tree) || isPlainObject(tree))) throw depthExceeded();
  if (Array.isArray(tree)) return tree.map((entry, index) => walk(entry, mode, [...segments, index], context));
  if (isPlainObject(tree)) {
    const walked: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(tree)) walked[key] = walk(entry, mode, [...segments, key], context);
    return walked;
  }
  if (tree instanceof DBRef) return readReference(tree, mode, segments, context);
  const { type, bytes } = elementOf(tree);
  // Subtype 0 is the one binary with a JavaScript form of its own; every other subtype keeps its
  // bytes, so a uuid or a decimal128 is stored and read back unchanged.
  if (type === BINARY && bytes[BINARY_SUBTYPE_AT] === 0x00) {
    return new Uint8Array(bytes.subarray(BINARY_PAYLOAD_AT));
  }
  if (OPAQUE_TYPE_BY_BYTE[type] === undefined) refuseAt('unsupported', segments, type);
  return makeOpaque(type, bytes);
}

/**
 * The library hands back a DBRef for two different things: a genuine dbPointer (wire type 0c) and any
 * ordinary embedded document whose fields are $ref and $id (and optionally $db). Only the first
 * cannot be written back as itself, so only the first is refused. The type byte of the stored element
 * decides, and it is in the bytes alone: the first time a DBRef is met in a document, the bytes are
 * walked once for their type 0c elements. A DBRef that is not one of those is an embedded document,
 * returned as the plain object it was stored as: $ref, $id, then $db if there was one, then the rest,
 * which is the order the library writes them in, so it is written back as it was read.
 */
function readReference(
  reference: DBRef,
  mode: Int64Mode,
  segments: readonly Segment[],
  context: ReadContext | undefined,
): unknown {
  if (context !== undefined) {
    context.genuineDbPointers ??= dbPointerPaths(context.bytes);
    if (context.genuineDbPointers.has(pathKey(segments))) refuseAt('dbPointer', segments);
  }
  const plain: Record<string, unknown> = {
    $ref: reference.collection,
    $id: walk(reference.oid, mode, [...segments, '$id'], context),
  };
  if (reference.db !== undefined) plain['$db'] = reference.db;
  for (const [key, entry] of Object.entries(reference.fields)) plain[key] = walk(entry, mode, [...segments, key], context);
  return plain;
}

/** `a.b[2].c`: the form the refusals name a field in. */
export function pathText(segments: readonly Segment[]): string {
  let text = '';
  for (const segment of segments) {
    if (typeof segment === 'number') text += `[${segment}]`;
    else text += text === '' ? segment : `.${segment}`;
  }
  return text;
}

function encode(value: unknown, path: string, depth: number): unknown {
  if (isWireDouble(value)) {
    const eight = new Uint8Array(8);
    new DataView(eight.buffer).setFloat64(0, value.double, true);
    return valueFromElement(DOUBLE, eight);
  }
  if (isOpaque(value)) {
    return valueFromElement(BYTE_BY_OPAQUE_TYPE[value.bsonType], value.bytes);
  }
  if (value === null) return null;
  switch (typeof value) {
    case 'string':
    case 'boolean':
    case 'number':
    case 'bigint':
      return value;
    default:
      // undefined, function and symbol have no BSON form; refusing is the only honest answer.
      if (typeof value !== 'object') return refuse(path, value);
  }
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) refuseOutOfRangeDateOnWrite(path);
    return value;
  }
  if (value instanceof Uint8Array) return valueFromElement(BINARY, genericBinaryBytes(value));
  if (Array.isArray(value) || isPlainObject(value)) {
    // The server refuses what it is sent past this depth, after the whole request has travelled; and
    // the walk below recurses, so a value nested past the stack would be a RangeError, not a refusal.
    if (depth > MAX_DEPTH) refuseDepth(path);
  }
  if (Array.isArray(value)) return value.map((entry, index) => encode(entry, `${path}[${index}]`, depth + 1));
  if (isPlainObject(value)) {
    const plain: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      // Dropped, not refused: a field nobody set must be absent on the wire, not a hole in it.
      if (entry === undefined) continue;
      if (key.includes('\0')) refuseKey(path, key);
      plain[key] = encode(entry, path === '' ? key : `${path}.${key}`, depth + 1);
    }
    return plain;
  }
  return refuse(path, value);
}

/** [int32 length][subtype 0x00][payload]: the element bytes of a generic binary. */
function genericBinaryBytes(payload: Uint8Array): Uint8Array {
  const element = new Uint8Array(4 + 1 + payload.length);
  new DataView(element.buffer).setInt32(0, payload.length, true);
  element[BINARY_SUBTYPE_AT] = 0x00;
  element.set(payload, BINARY_PAYLOAD_AT);
  return element;
}

/** Where a refusal happened, kept beside the error so the answer decoder can name the document. */
interface RefusalDetails {
  readonly segments: readonly Segment[];
  readonly wireType?: number;
  root?: unknown;
}

const DETAILS = new WeakMap<UnreadableValueError, RefusalDetails>();

/** The path, the wire type and the tree an {@link UnreadableValueError} was raised from, if the codec raised it. */
export function refusalDetails(error: UnreadableValueError): RefusalDetails | undefined {
  return DETAILS.get(error);
}

/** Remember the whole decoded tree, so the document a refusal is in can be named (its `_id_`). */
export function attachRoot(error: UnreadableValueError, root: unknown): void {
  const details = DETAILS.get(error);
  if (details !== undefined) details.root = root;
}

/** Carry the details of one refusal over to the error that replaces it. */
export function inheritDetails(from: UnreadableValueError, to: UnreadableValueError): void {
  const details = DETAILS.get(from);
  if (details !== undefined) DETAILS.set(to, details);
}

/** Where a refused value is, as the sentence names it: the document, then the field. */
export function whereText(field: string, document?: string, index?: number): string {
  if (document !== undefined && index !== undefined) return `Document "${document}" (index ${index} of this page), field "${field}"`;
  if (document !== undefined) return `Document "${document}", field "${field}"`;
  if (index !== undefined) return `The document at index ${index} of this page, field "${field}"`;
  return `field "${field}"`;
}

/** What each kind of value is and what the program can do about it, without saying where it is. */
function whatText(kind: UnreadableKind, wireType?: number): string {
  switch (kind) {
    case 'datetime':
      return 'a datetime outside the range a JavaScript Date can hold (±8.64e15 ms from the epoch). The driver refuses to read it rather than turn it into an Invalid Date and write the epoch back. Store the instant as an int64 or an ISO 8601 string instead.';
    case 'undefined':
      return 'a BSON undefined (type 06), which JavaScript cannot tell from a missing field. The driver refuses to read it rather than drop it on write. Store null instead, or omit the field.';
    case 'dbPointer':
      return 'a dbPointer (BSON type 0c), which cannot be written back as itself. The driver refuses to read it rather than write a different type. Store a plain document instead, for example { collection, id }.';
    case 'unsupported':
      return `a BSON value the driver cannot write back (wire type ${wireType ?? '?'}). The driver refuses to read it rather than write a different type.`;
  }
}

/**
 * What works when the document is already stored with the value: leave the field out of the read (a
 * find projection), and remove or replace it (an update). A value inside an array is excluded and
 * repaired as the whole array field, because that is the finest path a projection and $unset take.
 */
function repairText(field: string, document?: string): string {
  const inArray = field.includes('[');
  const path = inArray ? field.slice(0, field.indexOf('[')) : field;
  const quote = (text: string): string => `'${text.replaceAll('\\', '\\\\').replaceAll("'", "\\'")}'`;
  const name = /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(path) ? path : quote(path);
  const key = document === undefined ? '<key>' : quote(document);
  const scope = inArray ? `The value is inside the array field "${path}", so the whole array field is left out and repaired. ` : '';
  return (
    ` ${scope}To read the rest of the document, leave this field out of the read: bucket.find({}, { projection: { ${name}: 0 } }).` +
    ` To repair it, remove the field with bucket.update(${key}, { $unset: [${quote(path)}] }),` +
    ` or replace it with bucket.update(${key}, { $set: { ${name}: <a value that fits> } }).`
  );
}

/** The full sentence of a refusal of a value in a stored document. */
export function unreadableMessage(
  kind: UnreadableKind,
  field: string,
  place: { document?: string; index?: number; wireType?: number } = {},
): string {
  return `${whereText(field, place.document, place.index)} holds ${whatText(kind, place.wireType)}${repairText(field, place.document)}`;
}

function refuseAt(kind: UnreadableKind, segments: readonly Segment[], wireType?: number): never {
  const field = pathText(segments);
  const error = new UnreadableValueError({
    message: unreadableMessage(kind, field, { ...(wireType === undefined ? {} : { wireType }) }),
    operation: 'decode',
    valueKind: kind,
    field,
  });
  DETAILS.set(error, { segments, ...(wireType === undefined ? {} : { wireType }) });
  throw error;
}

/** A Date the caller built outside the range: bson would store the epoch in its place. */
function refuseOutOfRangeDateOnWrite(path: string): never {
  throw new InvalidArgumentError({
    message: `field "${path}" holds an Invalid Date (a Date whose time is outside ±8.64e15 ms from the epoch). Nothing was sent. Send a Date within that range, or store the instant as an int64 or an ISO 8601 string.`,
    operation: 'encode',
  });
}

function refuseDepth(path: string): never {
  throw new InvalidArgumentError({
    message: `${path === '' ? 'The value' : `The value at "${path}"`} is nested deeper than ${MAX_DEPTH} levels, which hoardDB refuses. Nothing was sent. Flatten it, or keep the inner part as its own document or bucket.`,
    operation: 'encode',
  });
}

/** A key is a BSON cstring: a NUL would end it early and shift every byte after it. */
function refuseKey(path: string, key: string): never {
  const where = path === '' ? 'a top-level field' : `a field of "${path}"`;
  throw new InvalidArgumentError({
    message: `The key ${JSON.stringify(key)}, ${where}, contains a NUL character, which a BSON key cannot hold. Nothing was sent. Remove the NUL from the key.`,
    operation: 'encode',
  });
}

function refuse(path: string, value: unknown): never {
  const name =
    typeof value === 'object' && value !== null ? value.constructor.name : typeof value;
  throw new InvalidArgumentError({
    message:
      `field "${path}" holds a ${name}; hoardDB stores strings, numbers, bigints, booleans, ` +
      'null, Dates, Uint8Arrays, arrays and plain objects',
    operation: 'encode',
  });
}

function isPlainObject(value: object): boolean {
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
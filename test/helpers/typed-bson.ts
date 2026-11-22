// SPDX-License-Identifier: Apache-2.0
//
// The typed JSON form of testdata/bson-vectors/v1.json (its `value_forms` glossary) turned into the
// canonical Extended JSON the driver's codec reads and writes (src/codec/ejson.ts). A document in the
// corpus is an ordered list of pairs, so wire order survives here as insertion order; a repeated key,
// or a key a JavaScript object would reorder, cannot be held in an object and is reported, not hidden.

import { hexToBytes } from './vectors.js';

type Tree = Record<string, unknown>;

function isTree(value: unknown): value is Tree {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A key a JavaScript object lists before the others, whatever order it was added in. */
function isArrayIndex(key: string): boolean {
  return /^(0|[1-9][0-9]{0,9})$/.test(key) && Number(key) < 2 ** 32 - 1;
}

/** The pairs of a `$doc` as an object in the same order, or the reason that cannot be done. */
function objectOfPairs(pairs: unknown): Tree {
  if (!Array.isArray(pairs)) throw new Error(`a $doc holds a list of pairs, not ${JSON.stringify(pairs)}`);
  const built: Tree = {};
  for (const pair of pairs) {
    if (!Array.isArray(pair) || pair.length !== 2 || typeof pair[0] !== 'string') {
      throw new Error(`a $doc pair is [key, value], not ${JSON.stringify(pair)}`);
    }
    const key = pair[0];
    if (Object.hasOwn(built, key)) {
      throw new Error(`the key ${JSON.stringify(key)} is repeated, which an object cannot hold`);
    }
    if (isArrayIndex(key)) {
      throw new Error(`the key ${JSON.stringify(key)} would be listed first by an object, so wire order is lost`);
    }
    built[key] = typedToExtendedJson(pair[1]);
  }
  return built;
}

/** One typed value → canonical Extended JSON (version 2), as src/codec/ejson.ts reads it. */
export function typedToExtendedJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(typedToExtendedJson);
  if (!isTree(value)) return value;

  const keys = Object.keys(value);
  const [form] = keys;
  if (keys.length !== 1 || form === undefined || !form.startsWith('$')) {
    throw new Error(`not a typed value of the corpus: ${JSON.stringify(value)}`);
  }
  const body = value[form];

  switch (form) {
    case '$doc':
      return objectOfPairs(body);
    case '$binary': {
      const { hex, subType } = body as { hex: string; subType: string };
      return { $binary: { base64: Buffer.from(hexToBytes(hex)).toString('base64'), subType } };
    }
    case '$codeWithScope': {
      const { code, scope } = body as { code: string; scope: unknown };
      return { $code: code, $scope: typedToExtendedJson(scope) };
    }
    case '$dbPointer': {
      const { namespace, oid } = body as { namespace: string; oid: string };
      return { $dbPointer: { $ref: namespace, $id: { $oid: oid } } };
    }
    case '$numberInt':
    case '$numberLong':
    case '$numberDouble':
    case '$numberDecimal':
    case '$date':
    case '$oid':
    case '$code':
    case '$symbol':
    case '$regularExpression':
    case '$timestamp':
    case '$minKey':
    case '$maxKey':
    case '$undefined':
      return value;
    default:
      throw new Error(`the corpus has no typed form named ${form}`);
  }
}

/**
 * A canonical Extended JSON tree in a form two trees can be compared by text, wire order included:
 * a double is reduced to its number (the corpus writes the shortest text that round-trips, bson may
 * write another spelling of the same value), everything else is kept as it is.
 */
export function comparable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(comparable);
  if (!isTree(value)) return value;
  const keys = Object.keys(value);
  if (keys.length === 1 && keys[0] === '$numberDouble' && typeof value['$numberDouble'] === 'string') {
    const text = value['$numberDouble'];
    if (text === 'NaN' || text === 'Infinity' || text === '-Infinity') return { $numberDouble: text };
    const parsed = Number(text);
    return { $numberDouble: Object.is(parsed, -0) ? '-0' : String(parsed) };
  }
  // The members of these wrappers are not elements of a document: their order is the library's
  // choice and says nothing about the wire.
  if (keys.length === 1 && WRAPPERS_WITHOUT_ORDER.has(keys[0] as string) && isTree(value[keys[0] as string])) {
    const wrapper = keys[0] as string;
    const body = value[wrapper] as Tree;
    const sorted: Tree = {};
    for (const member of Object.keys(body).sort()) sorted[member] = comparable(body[member]);
    return { [wrapper]: sorted };
  }
  const walked: Tree = {};
  for (const key of keys) walked[key] = comparable(value[key]);
  return walked;
}

const WRAPPERS_WITHOUT_ORDER: ReadonlySet<string> = new Set([
  '$timestamp',
  '$regularExpression',
  '$binary',
  '$dbPointer',
]);

/** The text two comparable trees are compared by: key order is part of it. */
export function orderedText(value: unknown): string {
  return JSON.stringify(comparable(value));
}

/**
 * A typed value as the plain JavaScript value a program would hand the driver, for the few vectors
 * that test the driver's own encoder (encode_refuse). Types with no JavaScript form are not built:
 * a program cannot construct them in version 1 (src/codec/values.ts, Opaque).
 */
export function typedToPlainValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(typedToPlainValue);
  if (!isTree(value)) return value;
  const keys = Object.keys(value);
  const [form] = keys;
  if (keys.length !== 1 || form === undefined) throw new Error(`not a typed value of the corpus: ${JSON.stringify(value)}`);
  const body = value[form];
  switch (form) {
    case '$doc':
      return objectOfPairsWith(body, typedToPlainValue);
    case '$numberInt':
      return Number(body);
    case '$numberLong':
      return BigInt(body as string);
    default:
      throw new Error(`the typed form ${form} has no plain JavaScript value`);
  }
}

function objectOfPairsWith(pairs: unknown, convert: (value: unknown) => unknown): Tree {
  const built: Tree = {};
  for (const [key, entry] of pairs as [string, unknown][]) built[key] = convert(entry);
  return built;
}

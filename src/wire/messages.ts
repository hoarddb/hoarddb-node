// SPDX-License-Identifier: Apache-2.0
//
// The wire names, typed in from the frozen vectors (build doc section 4.4.1). Nothing here guesses:
// `writeconcern` is one word, and a wrong name is refused by the server with no hint about which
// field was meant, so the tables are the contract and test/unit/leg1.test.ts holds them against the
// vectors in both directions. A field the answer does not model is carried through untouched: the
// server adds fields, and a decoder that failed on one would break on the next release.

import {
  decodeDocument,
  encodeDocument,
  inheritDetails,
  refusalDetails,
  unreadableMessage,
  type Int64Mode,
} from '../codec/index.js';
import { InvalidArgumentError, ProtocolError, UnreadableValueError } from '../errors.js';
import type { OpName } from './opcodes.js';

const FIELD_STORE_FIELDS = [
  'database',
  'bucket',
  'key',
  'field',
  'element',
  'path',
  'data',
  'content',
  'priority',
  'writeconcern',
] as const;

const FIELD_STORE_ANSWER = [
  'success',
  'message',
  'found',
  'element',
  'element_key',
  'position',
  'priority',
  'entry_id',
  'len',
  'items',
  'blob_id',
  'content',
  'copies_confirmed',
  'replication_factor',
  'write_outcome',
] as const;

/** The one request shape of ack, release and extend: item_ids is an ack's, lease_ms an extend's. */
const LEASE_REQUEST = ['database', 'bucket', 'lease_id', 'item_ids', 'lease_ms', 'writeconcern'] as const;
const LEASE_ANSWER = [
  'success',
  'lease_state',
  'acked',
  'missing',
  'remaining',
  'released',
  'lease_ms',
  'lease_deadline',
  'message',
  'copies_confirmed',
  'replication_factor',
  'write_outcome',
] as const;
const DEAD_MOVE_REQUEST = ['database', 'bucket', 'dead_id', 'all', 'after', 'writeconcern'] as const;
const DEAD_MOVE_ANSWER = [
  'success',
  'done',
  'left',
  'refused',
  'message',
  'copies_confirmed',
  'replication_factor',
  'write_outcome',
] as const;

/** Every wire name a request may carry, per opcode. A name not listed here is not on the wire. */
export const REQUEST_FIELDS: Readonly<Partial<Record<OpName, readonly string[]>>> = Object.freeze({
  AUTH: ['username', 'password', 'protocol_version', 'capabilities', 'client', 'token'],
  PUT: ['database', 'bucket', 'key', 'data', 'writeconcern'],
  UPSERT: ['database', 'bucket', 'key', 'data', 'writeconcern'],
  BTREE_INSERT: ['database', 'bucket', 'key', 'data', 'writeconcern'],
  GET: ['database', 'bucket', 'key'],
  BTREE_LOOKUP: ['database', 'bucket', 'key'],
  CONSISTENT_GET: ['database', 'bucket', 'key'],
  EXISTS: ['database', 'bucket', 'key'],
  DELETE: ['database', 'bucket', 'key', 'writeconcern', 'expire_if'],
  BATCH_PUT: ['database', 'bucket', 'data', 'writeconcern'],
  FIFO_PUSH: ['database', 'bucket', 'data', 'priority', 'writeconcern'],
  LIFO_PUSH: ['database', 'bucket', 'data', 'priority', 'writeconcern'],
  HEAP_PUSH: ['database', 'bucket', 'data', 'priority', 'writeconcern'],
  FIFO_POP: ['database', 'bucket', 'limit', 'writeconcern'],
  LIFO_POP: ['database', 'bucket', 'limit', 'writeconcern'],
  HEAP_POP: ['database', 'bucket', 'limit', 'writeconcern'],
  FIFO_PEEK: ['database', 'bucket', 'limit'],
  LIFO_PEEK: ['database', 'bucket', 'limit'],
  BTREE_RANGE: ['database', 'bucket', 'low', 'high', 'limit'],
  BTREE_FIRST: ['database', 'bucket', 'low', 'high', 'limit'],
  BTREE_LAST: ['database', 'bucket', 'low', 'high', 'limit'],
  BLOB_WRITE: ['database', 'bucket', 'key', 'data', 'metadata', 'writeconcern'],
  BLOB_READ: ['database', 'bucket', 'key'],
  CREATE_DB: ['name'],
  DELETE_DB: ['name'],
  CREATE_BUCKET: [
    'database',
    'name',
    'type',
    'schemajson',
    'options',
    'encrypted',
    'replication_factor',
    // On the wire and never sent by this driver: it has no option that sets them.
    'part',
    'part_of',
  ],
  DELETE_BUCKET: ['database', 'name'],
  LIST_BUCKETS: ['database'],
  LIST_DATABASES: [],
  BUCKET_STATS: ['database', 'bucket'],
  BUCKET_INFO: ['database', 'bucket'],
  COUNT: ['database', 'bucket', 'filter'],
  UPDATE: [
    'database',
    'bucket',
    'key',
    'set',
    'unset',
    'inc',
    'push',
    'addtoset',
    'mul',
    'min',
    'max',
    'rename',
    'filter',
    'multi',
    'writeconcern',
  ],
  SEARCH: ['database', 'bucket', 'filter', 'limit'],
  SCAN: [
    'database',
    'bucket',
    'filter',
    'skip',
    'limit',
    'sort',
    'projection',
    'expect_bucket_id',
  ],
  DISTINCT: ['database', 'bucket', 'field', 'filter'],
  PING: [],
  HEALTH_CHECK: [],
  LIST_NODES: ['history'],
  QUEUE_CLAIM: ['database', 'bucket', 'limit', 'lease_ms', 'writeconcern'],
  QUEUE_ACK: LEASE_REQUEST,
  QUEUE_RELEASE: LEASE_REQUEST,
  QUEUE_EXTEND: LEASE_REQUEST,
  DEAD_LIST: ['database', 'bucket', 'limit', 'after'],
  DEAD_REQUEUE: DEAD_MOVE_REQUEST,
  DEAD_DISCARD: DEAD_MOVE_REQUEST,
  FIELD_PUSH: FIELD_STORE_FIELDS,
  FIELD_POP: [...FIELD_STORE_FIELDS, 'limit'],
  FIELD_PUT: FIELD_STORE_FIELDS,
  FIELD_GET: FIELD_STORE_FIELDS,
  FIELD_DELETE: FIELD_STORE_FIELDS,
  FIELD_LEN: FIELD_STORE_FIELDS,
  FIELD_PEEK: [...FIELD_STORE_FIELDS, 'limit'],
  FIELD_LIST: [...FIELD_STORE_FIELDS, 'after', 'limit'],
  DECLARE_STORE_FIELDS: ['database', 'name', 'stores'],
  // A driver sends these three members and no other (wire.md section 4).
  ALTER_BUCKET: ['database', 'name', 'replication_factor'],
});

/** Every top-level wire name an answer may carry, per opcode. Nested names are not modelled. */
export const RESPONSE_FIELDS: Readonly<Partial<Record<OpName, readonly string[]>>> = Object.freeze({
  AUTH: [
    'success',
    'token',
    'message',
    'token_expires_at',
    'token_deadline',
    'protocol_version',
    'server_version',
    'capabilities',
    'password_min_length',
  ],
  PUT: [
    'id',
    'success',
    'message',
    'seq',
    'copies_confirmed',
    'replication_factor',
    'write_outcome',
  ],
  UPSERT: [
    'id',
    'success',
    'message',
    'seq',
    'copies_confirmed',
    'replication_factor',
    'write_outcome',
  ],
  BTREE_INSERT: [
    'id',
    'success',
    'message',
    'seq',
    'copies_confirmed',
    'replication_factor',
    'write_outcome',
  ],
  GET: ['found', 'data', 'message'],
  BTREE_LOOKUP: ['found', 'data', 'message'],
  CONSISTENT_GET: ['found', 'data', 'version', 'repaired', 'message'],
  EXISTS: ['exists'],
  DELETE: [
    'success',
    'message',
    'spared',
    'skipped',
    'copies_confirmed',
    'replication_factor',
    'write_outcome',
  ],
  BATCH_PUT: [
    'ids',
    'count',
    'success',
    'message',
    'copies_confirmed',
    'replication_factor',
    'write_outcome',
  ],
  FIFO_PUSH: [
    'id',
    'success',
    'message',
    'seq',
    'copies_confirmed',
    'replication_factor',
    'write_outcome',
  ],
  LIFO_PUSH: [
    'id',
    'success',
    'message',
    'seq',
    'copies_confirmed',
    'replication_factor',
    'write_outcome',
  ],
  HEAP_PUSH: [
    'id',
    'success',
    'message',
    'seq',
    'copies_confirmed',
    'replication_factor',
    'write_outcome',
  ],
  FIFO_POP: [
    'found',
    'items',
    'message',
    'copies_confirmed',
    'replication_factor',
    'write_outcome',
  ],
  LIFO_POP: [
    'found',
    'items',
    'message',
    'copies_confirmed',
    'replication_factor',
    'write_outcome',
  ],
  HEAP_POP: [
    'found',
    'items',
    'message',
    'copies_confirmed',
    'replication_factor',
    'write_outcome',
  ],
  FIFO_PEEK: ['found', 'items', 'message'],
  LIFO_PEEK: ['found', 'items', 'message'],
  BTREE_RANGE: ['entries', 'message'],
  BTREE_FIRST: ['entries', 'message'],
  BTREE_LAST: ['entries', 'message'],
  BLOB_WRITE: [
    'success',
    'key',
    'blobid',
    'size',
    'message',
    'copies_confirmed',
    'replication_factor',
    'write_outcome',
  ],
  BLOB_READ: ['found', 'blobid', 'data', 'size', 'metadata', 'message'],
  CREATE_DB: ['success', 'message'],
  DELETE_DB: ['success', 'message'],
  CREATE_BUCKET: ['success', 'message', 'placement'],
  DELETE_BUCKET: ['success', 'message'],
  LIST_BUCKETS: ['found', 'database', 'buckets', 'message', 'encrypted'],
  LIST_DATABASES: ['databases', 'message'],
  BUCKET_STATS: [
    'found',
    'database',
    'bucket',
    'type',
    'entries',
    'logical_bytes',
    'indexes',
    'message',
    'stores',
    'encrypted',
    'fields',
    'field_types',
    'writes_refused',
  ],
  // `bucket` is a document here, not the name it is in every other answer, so it is left out of the typed
  // names; the verb reads it itself.
  BUCKET_INFO: ['found', 'database', 'store_fields'],
  COUNT: ['count', 'message'],
  UPDATE: [
    'success',
    'doc',
    'message',
    'copies_confirmed',
    'replication_factor',
    'write_outcome',
  ],
  SEARCH: ['results', 'total', 'has_more', 'message', 'index_used'],
  SCAN: [
    'found',
    'database',
    'bucket',
    'documents',
    'total',
    'has_more',
    'message',
    'bucket_id',
    'index_used',
  ],
  DISTINCT: ['values', 'message'],
  PING: [],
  HEALTH_CHECK: [
    'nodeid',
    'uptime',
    'version',
    'bucketcount',
    'healthy',
    'capacity',
    'memtable',
    'encryption',
    'membership',
    'membership_detail',
    'store_refusal',
    'reasons',
    'host',
  ],
  LIST_NODES: ['nodes', 'history_reported', 'membership_history', 'schema_changes'],
  QUEUE_CLAIM: [
    'found',
    'items',
    'item_ids',
    'deliveries',
    'lease_id',
    'lease_ms',
    'lease_deadline',
    'pending',
    'dead',
    'returned',
    'message',
    'copies_confirmed',
    'replication_factor',
    'write_outcome',
  ],
  QUEUE_ACK: LEASE_ANSWER,
  QUEUE_RELEASE: LEASE_ANSWER,
  QUEUE_EXTEND: LEASE_ANSWER,
  DEAD_LIST: ['found', 'items', 'next', 'message'],
  DEAD_REQUEUE: DEAD_MOVE_ANSWER,
  DEAD_DISCARD: DEAD_MOVE_ANSWER,
  FIELD_PUSH: FIELD_STORE_ANSWER,
  FIELD_POP: FIELD_STORE_ANSWER,
  FIELD_PUT: FIELD_STORE_ANSWER,
  FIELD_GET: FIELD_STORE_ANSWER,
  FIELD_DELETE: FIELD_STORE_ANSWER,
  FIELD_LEN: FIELD_STORE_ANSWER,
  FIELD_PEEK: FIELD_STORE_ANSWER,
  FIELD_LIST: [...FIELD_STORE_ANSWER, 'entries', 'has_more', 'next'],
  DECLARE_STORE_FIELDS: ['success', 'message'],
  ALTER_BUCKET: ['success', 'message', 'replication_factor', 'previous_factor', 'pending', 'releasing'],
  ERROR: [
    'code',
    'message',
    'max_result_bytes',
    'retained_bytes',
    'write_outcome',
    'copies_confirmed',
    'replication_factor',
    'constraint_refusal',
  ],
  AUTH_FAIL: ['reason', 'message'],
});

/** The two requests the server accepts with no payload at all when there is nothing to say. */
export const EMPTY_PAYLOAD_REQUESTS: readonly OpName[] = Object.freeze(['PING', 'LIST_NODES']);

type FieldKind = 'string' | 'boolean' | 'integer' | 'array' | 'stringOrInteger';

const NAME_KINDS: Readonly<Record<string, FieldKind>> = Object.freeze({
  // `version` is the server's own version on a health answer (a string) and the document version on
  // a consistent read (an int64): one name, two fields, so both are accepted here (the vectors
  // carry both, and the document names only the string).
  version: 'stringOrInteger',
  message: 'string',
  placement: 'string',
  id: 'string',
  key: 'string',
  blobid: 'string',
  blob_id: 'string',
  entry_id: 'string',
  element_key: 'string',
  database: 'string',
  bucket: 'string',
  type: 'string',
  server_version: 'string',
  token: 'string',
  index_used: 'string',
  nodeid: 'string',
  uptime: 'string',
  success: 'boolean',
  found: 'boolean',
  exists: 'boolean',
  has_more: 'boolean',
  healthy: 'boolean',
  repaired: 'boolean',
  skipped: 'boolean',
  spared: 'boolean',
  seq: 'integer',
  count: 'integer',
  total: 'integer',
  size: 'integer',
  len: 'integer',
  position: 'integer',
  priority: 'integer',
  copies_confirmed: 'integer',
  replication_factor: 'integer',
  previous_factor: 'integer',
  releasing: 'array',
  token_expires_at: 'integer',
  token_deadline: 'integer',
  protocol_version: 'integer',
  password_min_length: 'integer',
  bucket_id: 'integer',
  lease_id: 'string',
  lease_state: 'string',
  dead_id: 'string',
  lease_ms: 'integer',
  acked: 'integer',
  missing: 'integer',
  remaining: 'integer',
  released: 'integer',
  pending: 'integer',
  dead: 'integer',
  returned: 'integer',
  done: 'integer',
  left: 'integer',
  item_ids: 'array',
  deliveries: 'array',
  refused: 'array',
  bucketcount: 'integer',
  max_result_bytes: 'integer',
  retained_bytes: 'integer',
  documents: 'array',
  results: 'array',
  items: 'array',
  ids: 'array',
  values: 'array',
  buckets: 'array',
  databases: 'array',
  nodes: 'array',
  capabilities: 'array',
});

/**
 * `pending` is a count of claimed entries on a queue's answers and the list of members an increase
 * newly places on an ALTER_BUCKET answer: one name, two fields.
 */
const PENDING_AS_ARRAY: ReadonlySet<OpName> = new Set<OpName>(['ALTER_BUCKET']);

/** `entries` is the documents a listing answer returns, and a count on a bucket's stats. */
const ENTRIES_AS_ARRAY: ReadonlySet<OpName> = new Set<OpName>([
  'BTREE_RANGE',
  'BTREE_FIRST',
  'BTREE_LAST',
  'FIELD_LIST',
]);

/**
 * A request payload for `op`: every field the opcode has, `undefined` dropped, and a refusal naming
 * any field it does not have. An opcode in {@link EMPTY_PAYLOAD_REQUESTS} with nothing left to say
 * is sent with no payload bytes at all.
 */
export function encodeRequest(op: OpName, fields: Record<string, unknown>): Uint8Array {
  const allowed = REQUEST_FIELDS[op] ?? [];
  const kept: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    if (!allowed.includes(name)) {
      const may = allowed.length > 0 ? `; it may carry ${allowed.join(', ')}` : '; it carries no field';
      throw new InvalidArgumentError({
        message: `${op} has no wire field "${name}"${may}`,
        operation: op,
        target: name,
      });
    }
    kept[name] = value;
  }
  if (Object.keys(kept).length === 0 && EMPTY_PAYLOAD_REQUESTS.includes(op)) return new Uint8Array(0);
  return encodeDocument(kept);
}

/**
 * An answer payload for `op`: the decoded fields, a field this driver does not model carried
 * through, and a refusal naming any modelled field whose JavaScript type is not the documented one.
 * A field that is absent, or that the server wrote as null because it has no value there, is not a
 * type error: `found: false` on a find is `documents: null`.
 */
export function decodeResponse(
  op: OpName,
  payload: Uint8Array,
  mode: Int64Mode,
): Record<string, unknown> {
  if (payload.length === 0) return {};
  let answer: Record<string, unknown>;
  try {
    answer = decodeDocument(payload, mode);
  } catch (error) {
    throw error instanceof UnreadableValueError ? locatedIn(error) : error;
  }
  for (const name of RESPONSE_FIELDS[op] ?? []) {
    const value = answer[name];
    if (value === undefined || value === null) continue;
    const kind =
      (name === 'entries' && ENTRIES_AS_ARRAY.has(op)) || (name === 'pending' && PENDING_AS_ARRAY.has(op))
        ? 'array'
        : NAME_KINDS[name];
    if (kind === undefined || holds(value, kind)) continue;
    throw new ProtocolError({
      message: `${op} answer field "${name}" is ${javascriptTypeOf(value)}, expected ${described(kind)}`,
      operation: op,
      target: name,
    });
  }
  return answer;
}

/** Answer fields that hold one document of the user's. */
const ONE_DOCUMENT: ReadonlySet<string> = new Set(['data', 'doc', 'element']);

/** Answer fields that hold a list of them (a find page, a search, a range, a peek, a field store's list). */
const A_LIST_OF_DOCUMENTS: ReadonlySet<string> = new Set(['documents', 'results', 'items', 'entries', 'values']);

function lookup(root: unknown, path: readonly (string | number)[]): unknown {
  let at = root;
  for (const step of path) {
    if (typeof at !== 'object' || at === null) return undefined;
    at = (at as Record<string | number, unknown>)[step];
  }
  return at;
}

/**
 * A refused value, said the way the program wrote it. The codec knows the path inside the server's
 * answer ("data.link", "documents[1].link"); the program wrote a document and looks for a field of it,
 * so the answer's own wrapping is taken off and the document is named by its key (_id_) or, in a page,
 * by its index. A refusal outside any such field keeps the path it has.
 */
function locatedIn(refusal: UnreadableValueError): UnreadableValueError {
  const details = refusalDetails(refusal);
  const [container, second] = details?.segments ?? [];
  if (details === undefined || typeof container !== 'string') return refusal;

  let inside: readonly (string | number)[] | undefined;
  let index: number | undefined;
  let where: readonly (string | number)[] = [container];
  if (ONE_DOCUMENT.has(container)) {
    inside = details.segments.slice(1);
  } else if (A_LIST_OF_DOCUMENTS.has(container) && typeof second === 'number') {
    index = second;
    where = [container, second];
    inside = details.segments.slice(2);
    // A listing of entries wraps each document: { key, data }.
    if (inside[0] === 'data' && (container === 'entries' || container === 'items')) {
      where = [...where, 'data'];
      inside = inside.slice(1);
    }
  }
  if (inside === undefined) return refusal;

  const holder = lookup(details.root, where) as Record<string, unknown> | undefined;
  const named = holder?.['_id_'];
  const entryKey = (lookup(details.root, [container, ...(index === undefined ? [] : [index])]) as Record<string, unknown> | undefined)?.['key'];
  const document = typeof named === 'string' ? named : typeof entryKey === 'string' ? entryKey : undefined;
  const field = inside.length > 0 ? pathOf(inside) : '(the value itself)';

  const located = new UnreadableValueError({
    message: unreadableMessage(refusal.valueKind, field, {
      ...(document === undefined ? {} : { document }),
      ...(index === undefined ? {} : { index }),
      ...(details.wireType === undefined ? {} : { wireType: details.wireType }),
    }),
    operation: refusal.operation,
    valueKind: refusal.valueKind,
    field,
    ...(document === undefined ? {} : { document }),
    ...(index === undefined ? {} : { index }),
  });
  inheritDetails(refusal, located);
  return located;
}

/** `a.b[2].c` from path segments. */
function pathOf(segments: readonly (string | number)[]): string {
  let text = '';
  for (const segment of segments) {
    if (typeof segment === 'number') text += `[${segment}]`;
    else text += text === '' ? segment : `.${segment}`;
  }
  return text;
}

function holds(value: unknown, kind: FieldKind): boolean {
  switch (kind) {
    case 'string':
      return typeof value === 'string';
    case 'boolean':
      return typeof value === 'boolean';
    // An int64 reaches JavaScript as a number when it is exactly representable and as a bigint when
    // it is not (D-24), so both are this kind.
    case 'integer':
      return typeof value === 'number' || typeof value === 'bigint';
    case 'array':
      return Array.isArray(value);
    case 'stringOrInteger':
      return typeof value === 'string' || typeof value === 'number' || typeof value === 'bigint';
  }
}

function javascriptTypeOf(value: unknown): string {
  if (Array.isArray(value)) return 'an array';
  if (typeof value === 'object') return 'an object';
  if (typeof value === 'bigint') return 'a bigint';
  return `a ${typeof value}`;
}

function described(kind: FieldKind): string {
  switch (kind) {
    case 'string':
      return 'a string';
    case 'boolean':
      return 'a boolean';
    case 'integer':
      return 'a number or a bigint';
    case 'array':
      return 'an array';
    case 'stringOrInteger':
      return 'a string or a number or a bigint';
  }
}
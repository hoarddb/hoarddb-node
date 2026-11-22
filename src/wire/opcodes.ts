// SPDX-License-Identifier: Apache-2.0
//
// The opcode table of handbook/wire.md §4. The driver never looks a store type up: the
// verb decides the opcode (build doc decision D-11).

export const Op = {
  AUTH: 0x01, AUTH_OK: 0x02, AUTH_FAIL: 0x03,
  PUT: 0x10, GET: 0x11, GET_RESPONSE: 0x12, DELETE: 0x13, EXISTS: 0x14, EXISTS_RESPONSE: 0x15,
  BATCH_PUT: 0x20, BATCH_PUT_OK: 0x21,
  FIFO_PUSH: 0x30, FIFO_POP: 0x31, FIFO_POP_RESPONSE: 0x32, FIFO_PEEK: 0x33,
  // Leases and dead entries (wire.md §4).
  QUEUE_CLAIM: 0x34, QUEUE_ACK: 0x35, QUEUE_RELEASE: 0x36, QUEUE_EXTEND: 0x37,
  DEAD_LIST: 0x38, DEAD_REQUEUE: 0x39, DEAD_DISCARD: 0x3a, DEAD_RESTORE: 0x3b,
  LIFO_PUSH: 0x40, LIFO_POP: 0x41, LIFO_POP_RESPONSE: 0x42, LIFO_PEEK: 0x43,
  BTREE_INSERT: 0x50, BTREE_LOOKUP: 0x51, BTREE_RANGE: 0x52, BTREE_RESPONSE: 0x53,
  HEAP_PUSH: 0x60, HEAP_POP: 0x61, HEAP_POP_RESPONSE: 0x62,
  BLOB_WRITE: 0x70, BLOB_READ: 0x71, BLOB_READ_RESPONSE: 0x72,
  CREATE_DB: 0x80, CREATE_BUCKET: 0x81, DELETE_DB: 0x82, DELETE_BUCKET: 0x83,
  LIST_BUCKETS: 0x84, LIST_DATABASES: 0x85, BUCKET_STATS: 0x86, COUNT: 0x87, UPDATE: 0x88,
  BTREE_FIRST: 0x89, BTREE_LAST: 0x8a, SEARCH: 0x8b, SCAN: 0x8c, DISTINCT: 0x8d, ALTER_BUCKET: 0x8e,
  GOSSIP: 0x90, CONSISTENT_GET: 0x9c, PING: 0xa0, PONG: 0xa1, ERROR: 0xa2, HEALTH_CHECK: 0xa3, LIST_NODES: 0xa4,
  // User administration (auth.md §6): outside the v1 application API, present so the conformance harness can replay it.
  USER_CREATE: 0xb5, USER_ALTER: 0xb6, USER_DROP: 0xb7, USER_LIST: 0xb8, USER_GET: 0xb9,
  USER_GRANT: 0xba, USER_REVOKE: 0xbb,
  GET_FAST: 0xc1, GET_FAST_RESPONSE: 0xc2,
  FIELD_PUSH: 0xd0, FIELD_POP: 0xd1, FIELD_PEEK: 0xd2, FIELD_PUT: 0xd3, FIELD_GET: 0xd4,
  FIELD_DELETE: 0xd5, FIELD_LEN: 0xd6, FIELD_LIST: 0xd7, DECLARE_STORE_FIELDS: 0xd8, BUCKET_INFO: 0xd9,
} as const;

/** The name of an opcode in {@link Op}. */
export type OpName = keyof typeof Op;

// Everything else answers its own opcode, so only the answers that differ from the request are
// named here (handbook wire.md §4: a response does not always carry the "response" opcode).
const DEDICATED_REPLY: Partial<Record<OpName, readonly number[]>> = {
  AUTH: [Op.AUTH_OK, Op.AUTH_FAIL],
  GET: [Op.GET_RESPONSE],
  EXISTS: [Op.EXISTS_RESPONSE],
  BATCH_PUT: [Op.BATCH_PUT_OK],
  FIFO_POP: [Op.FIFO_POP_RESPONSE],
  LIFO_POP: [Op.LIFO_POP_RESPONSE],
  HEAP_POP: [Op.HEAP_POP_RESPONSE],
  BTREE_LOOKUP: [Op.BTREE_RESPONSE],
  BTREE_RANGE: [Op.BTREE_RESPONSE],
  BLOB_READ: [Op.BLOB_READ_RESPONSE],
  PING: [Op.PONG],
  HEALTH_CHECK: [Op.GET_RESPONSE],
  LIST_NODES: [Op.GET_RESPONSE],
  GET_FAST: [Op.GET_FAST_RESPONSE],
};

// An answer only; a driver never sends one. AUTH_FAIL is here because the table above still has
// to name it as the second thing AUTH may come back with.
const ANSWERS_ONLY: readonly OpName[] = [
  'AUTH_OK', 'AUTH_FAIL', 'GET_RESPONSE', 'EXISTS_RESPONSE', 'BATCH_PUT_OK',
  'FIFO_POP_RESPONSE', 'LIFO_POP_RESPONSE', 'HEAP_POP_RESPONSE', 'BTREE_RESPONSE',
  'BLOB_READ_RESPONSE', 'GET_FAST_RESPONSE', 'PONG', 'ERROR',
];

const REQUESTS = (Object.keys(Op) as OpName[]).filter((name) => !ANSWERS_ONLY.includes(name));

/**
 * The success opcode(s) a request may be answered with (ERROR is always also possible).
 */
export const SUCCESS_REPLY: Readonly<Partial<Record<OpName, readonly number[]>>> = Object.freeze(
  Object.fromEntries(
    REQUESTS.map((name) => [name, DEDICATED_REPLY[name] ?? ([Op[name]] as const)]),
  ),
);

/** The name of an opcode: `PUT`, or `UNKNOWN(0x05)` for a byte the table does not carry. */
export function opName(code: number): string {
  for (const name of Object.keys(Op) as OpName[]) {
    if (Op[name] === code) return name;
  }
  return `UNKNOWN(0x${code.toString(16).padStart(2, '0')})`;
}
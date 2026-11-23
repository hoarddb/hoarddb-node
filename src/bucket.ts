// SPDX-License-Identifier: Apache-2.0
//
// One runtime class for every bucket and every typed view of one (decision D-1). A handle holds a
// client and three strings and does no I/O until a verb is called; the typed facets (hash, btree,
// fifo, ...) are the same object seen through a narrower type, so creating a million of them costs
// what one costs (rule 11). Step 11 built the bucket's DDL verbs and step 12 the keyed and queue
// verbs; the rest say so until their step builds them.

import type { ClientImpl } from './client-core.js';
import { Cursor, type Page, type PageFetcher } from './cursor.js';
import { BatchTooLargeError, type CallKind, type ErrorCode, InvalidArgumentError, NotFoundError, partialBatch } from './errors.js';
import { FieldStoreHandle } from './field-store.js';
import { consumeLoop, defaultConsumeEnv } from './consume.js';
import {
  ackResultOf,
  claimFailure,
  claimLimitOf,
  deadLimitOf,
  deadMoveOf,
  deadPageOf,
  itemIdsOf,
  leaseFailure,
  leaseIdOf,
  leaseMsOf,
  releaseResultOf,
  selectorFields,
  unreadableClaim,
} from './leases.js';
import { countRefusalsOf } from './refusals.js';
import { updateFields } from './update.js';
import {
  BATCH_NOTHING_WRITTEN,
  foundOrThrow,
  inbandRefusal,
  notFound,
  isDeleteMiss,
  isMiss,
  isUpdateMiss,
  messageOf,
  peekLimitOf,
  popLimitOf,
  priorityOf,
  writeResultOf,
} from './inband.js';
import type { Lane } from './pool.js';
import type { OpName } from './wire/opcodes.js';
import type {
  AckOptions,
  AckResult,
  AnyBucket,
  BatchResult,
  BlobWriteOptions,
  BlobWriteResult,
  Blob,
  BucketCopies,
  BucketDeclaration,
  BucketStats,
  ClaimOptions,
  Claimed,
  ConsumeHandler,
  Delivery,
  ConsumeOptions,
  DeadListOptions,
  DeadMoveResult,
  DeadPage,
  DeadSelector,
  Doc,
  Entry,
  FieldStore,
  FindOptions,
  Filter,
  OpOptions,
  RangeOptions,
  SearchOptions,
  PeekOptions,
  PopOptions,
  PushOptions,
  ReadOptions,
  ReleaseResult,
  Stored,
  StoreType,
  UpdateOps,
  WriteConcern,
  WriteOptions,
  WriteResult,
} from './types.js';

/**
 * A page of a cursor that halves on RESULT_TOO_LARGE: call() leaves that refusal uncounted, because the
 * cursor recovers from it; the one the cursor finally throws is counted by its own counter, once.
 */
export const HALVING_CURSOR: readonly ErrorCode[] = ['RESULT_TOO_LARGE'];

/** The page size a query asks for when the caller names none. */
const DEFAULT_PAGE = 100;

/** The filter a query sends, or none: an absent filter is omitted, as the distinct vector sends it. */
function withFilter(filter: unknown): Record<string, unknown> {
  return filter === undefined ? {} : { filter };
}

/** A value that exists only when the answer carries it. */
function optionalNumber(value: unknown): number | undefined {
  return value === undefined ? undefined : Number(value);
}

/** The smaller of two optional counts, or whichever one is there. */
function minDefined(first: number | undefined, second: number | undefined): number | undefined {
  if (first === undefined) return second;
  if (second === undefined) return first;
  return Math.min(first, second);
}

/** Drops the keys an answer did not carry, so an absent field stays absent on the result. */
function compact<R>(values: Record<string, unknown>): R {
  return Object.fromEntries(Object.entries(values).filter(([, value]) => value !== undefined)) as R;
}

/** What a caller passed where a key belongs, for the refusal that names it. */
function describedKey(key: unknown): string {
  if (key === undefined) return 'undefined';
  if (key === null) return 'null';
  if (key === '') return 'an empty string';
  if (Array.isArray(key)) return 'an array';
  const type = typeof key;
  return /^[aeiou]/.test(type) ? `an ${type}` : `a ${type}`;
}

/**
 * Refuses a keyed write whose key is not a non-empty string, before a frame exists. The types already
 * say `string`, but plain JavaScript passes anything, and the server reads a missing or empty key as
 * "assign one": the write would land under a key nobody asked for, a new one on every call.
 */
function requireWriteKey(key: unknown, operation: string, target: string, otherwise: string): void {
  if (typeof key === 'string' && key !== '') return;
  throw new InvalidArgumentError({
    message: `${operation} needs a key: a non-empty string, got ${describedKey(key)}. ${otherwise}`,
    operation,
    target,
    writeOutcome: 'not_applied',
  });
}

/** What to do instead, for a document write with no key. */
const OR_INSERT = 'Pass the key, or use insert(doc) to let the server assign one.';

/** The typed view of a bucket handle: the same object, a narrower static type (decision D-1). */
export function facet<F>(handle: object): F {
  return handle as unknown as F;
}

/** An answer that says success: false: the server's sentence, verbatim, as InvalidArgumentError (section 5.2). */
export function refusedInBand(answer: Record<string, unknown>, operation: string, target: string): InvalidArgumentError {
  return new InvalidArgumentError({ message: messageOf(answer), operation, target });
}

/** The owner's view of a bucket's copies, from a `list buckets` row or a `bucket info` bucket; absent members stay absent. */
export function copiesOf(bucket: Record<string, unknown>): BucketCopies {
  const copies: BucketCopies = {};
  if (bucket['in_sync'] !== undefined) copies.inSync = Number(bucket['in_sync']);
  if (typeof bucket['state'] === 'string') copies.state = bucket['state'];
  if (Array.isArray(bucket['not_in_sync'])) copies.notInSync = bucket['not_in_sync'] as string[];
  if (Array.isArray(bucket['pending_copies'])) {
    copies.pendingCopies = (bucket['pending_copies'] as Record<string, unknown>[]).map((copy) => ({
      node: copy['node'] as string,
      since: Number(copy['since']),
    }));
  }
  return copies;
}

export class BucketHandle<T extends object = Doc> implements AnyBucket<T> {
  // The client is held in an ES private field: inspect and JSON never walk from a handle to it.
  readonly #client: ClientImpl;

  constructor(
    client: ClientImpl,
    readonly database: string,
    readonly name: string,
    readonly type: StoreType | undefined,
  ) {
    this.#client = client;
  }

  /** The client behind the handle (field stores send through it). A getter, so inspect does not walk it. */
  get client(): ClientImpl {
    return this.#client;
  }

  /** The bucket's address in the driver's spelling, for every error it raises. */
  private get target(): string {
    return `${this.database}/${this.name}`;
  }

  /** The address of one document: 'db/bucket/key'. */
  #keyTarget(key: string): string {
    return `${this.database}/${this.name}/${key}`;
  }

  /** The write concern a write carries: the call's own, else the client's default (D-19). */
  #writeOptions(opts: WriteOptions | undefined): OpOptions & { writeConcern?: WriteConcern } {
    return {
      signal: opts?.signal,
      timeoutMs: opts?.timeoutMs,
      writeConcern: opts?.writeConcern ?? this.client.options.writeConcern,
    };
  }

  /** One request on this bucket: the bucket's name goes in every payload the verbs send. */
  #request(
    operation: string,
    target: string,
    op: OpName,
    kind: CallKind,
    fields: Record<string, unknown>,
    opts?: OpOptions & { writeConcern?: WriteConcern },
    lane: Lane = 'point',
    uncounted?: readonly ErrorCode[],
  ): Promise<Record<string, unknown>> {
    return this.client.send({
      operation,
      target,
      op,
      fields: { database: this.database, bucket: this.name, ...fields },
      lane,
      kind,
      opts,
      ...(uncounted === undefined ? {} : { uncounted }),
    });
  }

  async stats(opts?: OpOptions): Promise<BucketStats> {
    const answer = await this.client.send({
      operation: 'stats',
      target: this.target,
      op: 'BUCKET_STATS',
      fields: { database: this.database, bucket: this.name },
      lane: 'point',
      kind: 'read',
      opts,
    });
    return {
      database: this.database,
      bucket: this.name,
      type: answer['type'] as StoreType,
      entries: Number(answer['entries']),
      ...copiesOf(answer),
      raw: answer,
    };
  }

  async info(opts?: OpOptions): Promise<BucketDeclaration> {
    const answer = await this.client.send({
      operation: 'info',
      target: this.target,
      op: 'BUCKET_INFO',
      fields: { database: this.database, bucket: this.name },
      lane: 'point',
      // A read: a lost connection is retried once, UNAVAILABLE with a backoff (handbook errors.md section 6).
      kind: 'read',
      opts,
    });
    const bucket = (answer['bucket'] ?? {}) as Record<string, unknown>;
    const storeFields = (answer['store_fields'] ?? []) as { name: string; engine: string }[];
    const declaration: BucketDeclaration = {
      name: bucket['name'] as string,
      type: bucket['type'] as StoreType,
      entries: Number(bucket['entries']),
      stores: (bucket['stores'] ?? []) as string[],
      storeFields: storeFields.map((field) => ({ name: field.name, engine: field.engine })),
    };
    if (bucket['replication_factor'] !== undefined) declaration.replicationFactor = Number(bucket['replication_factor']);
    if (typeof bucket['inherited'] === 'boolean') declaration.inherited = bucket['inherited'];
    return Object.assign(declaration, copiesOf(bucket));
  }

  async drop(opts?: OpOptions): Promise<void> {
    const answer = await this.client.send({
      operation: 'drop',
      target: this.target,
      op: 'DELETE_BUCKET',
      fields: { database: this.database, name: this.name },
      lane: 'point',
      kind: 'ddl',
      opts,
    });
    if (answer['success'] !== true) throw refusedInBand(answer, 'drop', this.target);
  }

  async put(key: string, doc: T, opts?: WriteOptions): Promise<WriteResult> {
    requireWriteKey(key, 'put', this.target, OR_INSERT);
    const answer = await this.#request('put', this.#keyTarget(key), 'PUT', 'write', { key, data: doc }, this.#writeOptions(opts));
    if (answer['success'] === false) throw inbandRefusal(answer, { operation: 'put', target: this.#keyTarget(key) });
    return writeResultOf(answer);
  }

  async upsert(key: string, doc: T, opts?: WriteOptions): Promise<WriteResult> {
    requireWriteKey(key, 'upsert', this.target, OR_INSERT);
    const target = this.#keyTarget(key);
    const answer = await this.#request('upsert', target, 'UPSERT', 'write', { key, data: doc }, this.#writeOptions(opts));
    if (answer['success'] === false) throw inbandRefusal(answer, { operation: 'upsert', target });
    return writeResultOf(answer);
  }

  async insert(doc: T, opts?: WriteOptions): Promise<WriteResult> {
    const answer = await this.#request('insert', this.target, 'PUT', 'write', { key: '', data: doc }, this.#writeOptions(opts));
    if (answer['success'] === false) throw inbandRefusal(answer, { operation: 'insert', target: this.target });
    return writeResultOf(answer);
  }

  async get(key: string, opts?: ReadOptions): Promise<Stored<T>> {
    const target = this.#keyTarget(key);
    const consistent = opts?.consistent === true;
    if (consistent) this.client.requireCapability('consistent_get', '{ consistent: true }', 'get', target);
    const answer = await this.#request(
      'get',
      target,
      consistent ? 'CONSISTENT_GET' : 'GET',
      'read',
      { key },
      opts,
    );
    return foundOrThrow<T>(answer, { operation: 'get', target });
  }

  async exists(key: string, opts?: OpOptions): Promise<boolean> {
    const answer = await this.#request('exists', this.#keyTarget(key), 'EXISTS', 'read', { key }, opts);
    return answer['exists'] === true;
  }

  async delete(key: string, opts?: WriteOptions): Promise<boolean> {
    const target = this.#keyTarget(key);
    const answer = await this.#request('delete', target, 'DELETE', 'write', { key }, this.#writeOptions(opts));
    if (answer['success'] === true) return true;
    if (isDeleteMiss(answer)) return false;
    throw inbandRefusal(answer, { operation: 'delete', target });
  }

  async push(doc: T, opts?: PushOptions): Promise<WriteResult> {
    // Every push vector sends priority as an int64, 0 when the caller gives none: the server stores a
    // priority-less heap push at 0 and a queue ignores it, so 0 is the same request.
    const fields: Record<string, unknown> = { data: doc, priority: priorityOf(opts?.priority ?? 0, this.target) };
    const answer = await this.#request('push', this.target, 'FIFO_PUSH', 'write', fields, this.#writeOptions(opts));
    if (answer['success'] === false) throw inbandRefusal(answer, { operation: 'push', target: this.target });
    return writeResultOf(answer);
  }

  async pop(opts?: PopOptions): Promise<Stored<T>[]> {
    const limit = popLimitOf(opts?.limit, this.target);
    const fields = limit === undefined ? {} : { limit };
    const answer = await this.#request('pop', this.target, 'FIFO_POP', 'write', fields, this.#writeOptions(opts));
    // The server answers a pop with a list, as a peek does, in pop order.
    if (answer['found'] === true) return (answer['items'] ?? []) as Stored<T>[];
    if (isMiss(answer)) return [];
    throw inbandRefusal(answer, { operation: 'pop', target: this.target });
  }

  async peek(opts?: PeekOptions): Promise<Stored<T>[]> {
    const limit = peekLimitOf(opts?.limit, this.target);
    const answer = await this.#request('peek', this.target, 'FIFO_PEEK', 'read', { limit }, opts);
    if (answer['found'] === true) return (answer['items'] ?? []) as Stored<T>[];
    if (isMiss(answer)) return [];
    throw inbandRefusal(answer, { operation: 'peek', target: this.target });
  }

  async claim(opts?: ClaimOptions): Promise<Claimed<T>> {
    const target = this.target;
    const limit = claimLimitOf(opts?.limit, 'claim', target);
    const leaseMs = leaseMsOf(opts?.lease, 'claim', target);
    const fields = { limit, lease_ms: leaseMs === undefined ? undefined : BigInt(leaseMs) };
    let answer: Record<string, unknown>;
    try {
      // INVALID_ARGUMENT is left uncounted here: the hard-cap refusal changes class below, and the public
      // method counts whichever error finally leaves.
      answer = await this.#request('claim', target, 'QUEUE_CLAIM', 'write', fields, this.#writeOptions(opts), 'point', ['INVALID_ARGUMENT']);
    } catch (error) {
      throw claimFailure(error);
    }
    const returned = Number(answer['returned'] ?? 0);
    const items = (answer['items'] ?? []) as Stored<T>[];
    if (answer['found'] === true && items.length > 0) return this.#claimed(answer, items, target);
    // Found false is nothing to take, or a refusal (a store type with no order): only a message other than
    // the empty-queue sentences says refusal. A claim that gave expired leases back is not empty.
    if (answer['found'] !== true && returned === 0 && !isMiss(answer)) throw inbandRefusal(answer, { operation: 'claim', target });
    return { leaseId: '', grantedMs: 0, items: [], pending: Number(answer['pending'] ?? 0), dead: Number(answer['dead'] ?? 0), returned };
  }

  #claimed(answer: Record<string, unknown>, items: Stored<T>[], target: string): Claimed<T> {
    const itemIds = (answer['item_ids'] ?? []) as string[];
    const deliveries = (answer['deliveries'] ?? []) as (number | bigint)[];
    const leaseId = answer['lease_id'];
    if (
      typeof leaseId !== 'string' ||
      !/^[0-9a-f]{40}$/i.test(leaseId) ||
      itemIds.length !== items.length ||
      (deliveries.length !== 0 && deliveries.length !== items.length)
    ) {
      throw unreadableClaim(answer, target);
    }
    const lease = leaseId.toLowerCase();
    return {
      leaseId: lease,
      grantedMs: Number(answer['lease_ms'] ?? 0),
      items: items.map(
        (document, position): Delivery<T> => ({
          itemId: itemIds[position] as string,
          document,
          deliveries: deliveries.length === 0 ? 1 : Number(deliveries[position]),
          extend: (ms, opts) => this.extend(lease, ms, opts),
        }),
      ),
      pending: Number(answer['pending'] ?? 0),
      dead: Number(answer['dead'] ?? 0),
      returned: Number(answer['returned'] ?? 0),
    };
  }

  async ack(leaseId: string, opts?: AckOptions): Promise<AckResult> {
    const target = this.target;
    const lease = leaseIdOf(leaseId, 'ack', target);
    const itemIds = itemIdsOf(opts?.itemIds, target);
    const answer = await this.#request('ack', target, 'QUEUE_ACK', 'write', { lease_id: lease, item_ids: itemIds }, this.#writeOptions(opts));
    const result = ackResultOf(answer);
    if (answer['success'] !== true) throw leaseFailure(answer, 'ack', target, result);
    return result;
  }

  async release(leaseId: string, opts?: WriteOptions): Promise<ReleaseResult> {
    const target = this.target;
    const lease = leaseIdOf(leaseId, 'release', target);
    const answer = await this.#request('release', target, 'QUEUE_RELEASE', 'write', { lease_id: lease }, this.#writeOptions(opts));
    const result = releaseResultOf(answer);
    if (answer['success'] !== true) throw leaseFailure(answer, 'release', target, result);
    return result;
  }

  async extend(leaseId: string, ms: number, opts?: WriteOptions): Promise<number> {
    const target = this.target;
    const lease = leaseIdOf(leaseId, 'extend', target);
    // Required: an extend with no length is refused here, as the server would.
    const length = leaseMsOf(ms, 'extend', target) ?? leaseMsOf(Number.NaN, 'extend', target);
    const answer = await this.#request('extend', target, 'QUEUE_EXTEND', 'write', { lease_id: lease, lease_ms: BigInt(length as number) }, this.#writeOptions(opts));
    if (answer['success'] !== true) throw leaseFailure(answer, 'extend', target, ackResultOf(answer));
    return Number(answer['lease_ms'] ?? 0);
  }

  consume(handler: ConsumeHandler<T>, opts?: ConsumeOptions): Promise<void> {
    return consumeLoop<T>(this, this.target, handler, opts, { ...defaultConsumeEnv, logger: this.client.options.logger });
  }

  async deadList(opts?: DeadListOptions): Promise<DeadPage<T>> {
    const target = this.target;
    const limit = deadLimitOf(opts?.limit, target);
    const after = opts?.after === undefined || opts.after === '' ? undefined : opts.after;
    // A read: a lost connection is retried once (handbook errors.md section 6).
    const answer = await this.#request('deadList', target, 'DEAD_LIST', 'read', { limit, after }, opts);
    return deadPageOf<T>(answer, target);
  }

  requeue(selector: DeadSelector, opts?: WriteOptions): Promise<DeadMoveResult> {
    return this.#deadMove('requeue', 'DEAD_REQUEUE', selector, opts);
  }

  discard(selector: DeadSelector, opts?: WriteOptions): Promise<DeadMoveResult> {
    return this.#deadMove('discard', 'DEAD_DISCARD', selector, opts);
  }

  async #deadMove(operation: string, op: 'DEAD_REQUEUE' | 'DEAD_DISCARD', selector: DeadSelector, opts?: WriteOptions): Promise<DeadMoveResult> {
    const target = this.target;
    const fields = selectorFields(selector, operation, target);
    const answer = await this.#request(operation, target, op, 'write', fields, this.#writeOptions(opts));
    return deadMoveOf(answer, operation, target);
  }

  async count(filter?: Filter<T>, opts?: OpOptions): Promise<number> {
    // A blob bucket's count takes only options (BlobBucket.count), so on it the one argument is read as them.
    if (this.type === 'blob') {
      const answer = await this.#request('count', this.target, 'COUNT', 'read', {}, filter as unknown as OpOptions | undefined);
      return Number(answer['count']);
    }
    const answer = await this.#request('count', this.target, 'COUNT', 'read', withFilter(filter), opts);
    return Number(answer['count']);
  }

  find(filter?: Filter<T>, opts?: FindOptions<T>): Cursor<Stored<T>> {
    const sort = opts?.sort;
    const sortKeys = sort === undefined ? 0 : Object.keys(sort).length;
    if (sortKeys > 1) {
      throw new InvalidArgumentError({
        message: `sort takes exactly one field; got ${sortKeys}`,
        operation: 'find',
        target: this.target,
      });
    }

    const target = this.target;
    /** Documents the scan has returned so far: the skip and the remaining limit count from it. */
    let returned = 0;
    /** The previous page's bucket_id, which the next page must still name (from page 2). */
    let expectBucketId: bigint | undefined;
    const fetch: PageFetcher<Stored<T>> = async ({ pageSize }) => {
      const remaining = opts?.limit === undefined ? pageSize : Math.min(pageSize, opts.limit - returned);
      const fields: Record<string, unknown> = { skip: (opts?.skip ?? 0) + returned, limit: remaining };
      if (filter !== undefined) fields['filter'] = filter;
      if (sort !== undefined) fields['sort'] = sort;
      if (opts?.projection !== undefined) fields['projection'] = opts.projection;
      if (expectBucketId !== undefined) fields['expect_bucket_id'] = expectBucketId;
      const answer = await this.#scan('find', target, fields, opts, 'SCAN', HALVING_CURSOR);
      if (answer['found'] === false) {
        // A refused verb (find on a blob) is an ERROR frame, INVALID_ARGUMENT, passed through by call();
        // found: false is only a miss or a server that still answers a refusal in band (errors.md section 3).
        if (messageOf(answer).includes('not found')) throw new NotFoundError({ message: messageOf(answer), operation: 'find', target });
        throw inbandRefusal(answer, { operation: 'find', target });
      }
      const documents = (answer['documents'] ?? []) as Stored<T>[];
      returned += documents.length;
      const bucketId = answer['bucket_id'];
      expectBucketId = bucketId === undefined ? undefined : BigInt(bucketId as number | bigint);
      return compact<Page<Stored<T>>>({ items: documents, done: answer['has_more'] !== true, total: optionalNumber(answer['total']) });
    };
    return new Cursor<Stored<T>>(fetch, { pageSize: opts?.pageSize ?? DEFAULT_PAGE, limit: opts?.limit, halveOnTooLarge: true });
  }

  async findOne(filter?: Filter<T>, opts?: OpOptions): Promise<Stored<T>> {
    const found = await this.find(filter, { signal: opts?.signal, timeoutMs: opts?.timeoutMs, limit: 1 }).next();
    if (found === null) {
      throw notFound(
        { operation: 'findOne', target: this.target },
        `No document in ${this.target} matches the filter.`,
        'Use find(filter).toArray() to get a list that may be empty, or catch NotFoundError.',
      );
    }
    return found;
  }

  async distinct(field: keyof T & string, filter?: Filter<T>, opts?: OpOptions): Promise<unknown[]> {
    const answer = await this.#scan('distinct', this.target, { field, ...withFilter(filter) }, opts, 'DISTINCT');
    return (answer['values'] ?? []) as unknown[];
  }

  search(filter: Filter<T>, opts?: SearchOptions): Cursor<Stored<T>> {
    const limit = opts?.limit ?? DEFAULT_PAGE;
    const fetch: PageFetcher<Stored<T>> = async () => {
      const answer = await this.#scan('search', this.target, { filter, limit }, opts, 'SEARCH');
      const hasMore = answer['has_more'];
      return compact<Page<Stored<T>>>({
        items: (answer['results'] ?? []) as Stored<T>[],
        done: true,
        total: optionalNumber(answer['total']),
        hasMore: typeof hasMore === 'boolean' ? hasMore : undefined,
      });
    };
    return new Cursor<Stored<T>>(fetch, { pageSize: limit, halveOnTooLarge: false });
  }

  range(bounds: { gte?: string; lte?: string }, opts?: RangeOptions): Cursor<Entry<T>> {
    const pageSize = opts?.pageSize ?? DEFAULT_PAGE;
    /** The last key the range has returned: later pages start there and drop its repeat. */
    let lastKey: string | undefined;
    const fetch: PageFetcher<Entry<T>> = async ({ pageSize: size }) => {
      const first = lastKey === undefined;
      const asked = first ? size : size + 1;
      const low = first ? (bounds.gte ?? '') : lastKey;
      const answer = await this.#scan('range', this.target, { low, high: bounds.lte ?? '', limit: asked }, opts, 'BTREE_RANGE', HALVING_CURSOR);
      const raw = (answer['entries'] ?? []) as Entry<T>[];
      const previous = lastKey;
      const last = raw[raw.length - 1];
      if (last !== undefined) lastKey = last.key;
      const repeated = !first && raw[0]?.key === previous;
      return { items: repeated ? raw.slice(1) : raw, done: raw.length < asked };
    };
    return new Cursor<Entry<T>>(fetch, { pageSize, limit: opts?.limit, halveOnTooLarge: true });
  }

  async first(opts?: OpOptions): Promise<Entry<T>> {
    return this.#edge('first', 'BTREE_FIRST', opts);
  }

  async last(opts?: OpOptions): Promise<Entry<T>> {
    return this.#edge('last', 'BTREE_LAST', opts);
  }

  /** A query on this bucket, in the bulk lane unless the verb names the point lane (section 3.4). */
  #scan(
    operation: string,
    target: string,
    fields: Record<string, unknown>,
    opts: OpOptions | undefined,
    op: OpName = 'SCAN',
    uncounted?: readonly ErrorCode[],
  ): Promise<Record<string, unknown>> {
    return this.client.send({
      operation,
      target,
      op,
      fields: { database: this.database, bucket: this.name, ...fields },
      lane: op === 'COUNT' || op === 'BTREE_FIRST' || op === 'BTREE_LAST' ? 'point' : 'bulk',
      kind: 'read',
      opts,
      ...(uncounted === undefined ? {} : { uncounted }),
    });
  }

  /** The first or last entry of a btree; an empty tree is NotFoundError. */
  async #edge(operation: string, op: 'BTREE_FIRST' | 'BTREE_LAST', opts: OpOptions | undefined): Promise<Entry<T>> {
    const answer = await this.#scan(operation, this.target, { low: '', high: '', limit: 0 }, opts, op);
    const entries = (answer['entries'] ?? []) as Entry<T>[];
    const edge = entries[0];
    if (edge === undefined) {
      throw notFound(
        { operation, target: this.target },
        `${this.target} is empty, so it has no ${operation} entry.`,
        `Put an entry first with put(key, doc), or use range() to read a list that may be empty.`,
      );
    }
    return edge;
  }

  async insertMany(docs: readonly (T & { _id_?: string })[], opts?: WriteOptions): Promise<BatchResult> {
    const target = this.target;
    let answer: Record<string, unknown>;
    try {
      answer = await this.#request('insertMany', target, 'BATCH_PUT', 'write', { data: docs }, this.#writeOptions(opts), 'bulk');
    } catch (error) {
      // A batch refused whole with nothing written is split as the old in-band refusal always was (D-20).
      // An 'unknown' outcome may have been applied by a cluster member, so it is never split: the caller reads back.
      if (docs.length > 1 && error instanceof BatchTooLargeError && error.writeOutcome !== 'unknown') {
        return this.#insertManyHalved(docs, opts);
      }
      throw error;
    }
    if (answer['success'] === true) {
      return {
        ids: answer['ids'] as string[],
        count: Number(answer['count']),
        copiesConfirmed: optionalNumber(answer['copies_confirmed']),
        replicationFactor: optionalNumber(answer['replication_factor']),
      };
    }
    // The server refuses a batch whole when it cannot take it all: each half is sent in order, down to one
    // document, whose refusal is the caller's (decision D-20).
    if (docs.length > 1 && messageOf(answer).includes(BATCH_NOTHING_WRITTEN)) {
      return this.#insertManyHalved(docs, opts);
    }
    throw inbandRefusal(answer, { operation: 'insertMany', target });
  }

  /** Sends each half in order and merges the receipts; a refused later half carries what was written (D-20). */
  async #insertManyHalved(docs: readonly (T & { _id_?: string })[], opts?: WriteOptions): Promise<BatchResult> {
    const half = Math.ceil(docs.length / 2);
    const first = await this.insertMany(docs.slice(0, half), opts);
    let second: BatchResult;
    try {
      second = await this.insertMany(docs.slice(half), opts);
    } catch (error) {
      // The first half is written: the refusal of the second must say so (D-20).
      throw partialBatch(error, first.count);
    }
    return {
      ids: [...first.ids, ...second.ids],
      count: first.count + second.count,
      copiesConfirmed: minDefined(first.copiesConfirmed, second.copiesConfirmed),
      replicationFactor: minDefined(first.replicationFactor, second.replicationFactor),
    };
  }

  field<E extends object = Doc>(key: string, field: string): FieldStore<E> {
    return new FieldStoreHandle<E>(this, key, field, []);
  }

  async putBlob(key: string, data: Uint8Array, opts?: BlobWriteOptions): Promise<BlobWriteResult> {
    requireWriteKey(key, 'putBlob', this.target, 'Pass the key to store the blob under.');
    const target = this.#keyTarget(key);
    const fields: Record<string, unknown> = { key, data };
    if (opts?.metadata !== undefined) fields['metadata'] = opts.metadata;
    const answer = await this.#request('putBlob', target, 'BLOB_WRITE', 'write', fields, this.#writeOptions(opts), 'bulk');
    if (answer['success'] === false) throw inbandRefusal(answer, { operation: 'putBlob', target });
    return compact<BlobWriteResult>({
      key: answer['key'] as string,
      blobId: answer['blobid'] as string,
      size: Number(answer['size']),
      copiesConfirmed: optionalNumber(answer['copies_confirmed']),
      replicationFactor: optionalNumber(answer['replication_factor']),
    });
  }

  async getBlob(key: string, opts?: OpOptions): Promise<Blob> {
    const target = this.#keyTarget(key);
    const answer = await this.#request('getBlob', target, 'BLOB_READ', 'read', { key }, opts, 'bulk');
    if (answer['found'] === true) {
      return {
        key,
        blobId: answer['blobid'] as string,
        size: Number(answer['size']),
        data: answer['data'] as Uint8Array,
        metadata: (answer['metadata'] ?? {}) as Doc,
      };
    }
    if (isMiss(answer)) {
      throw notFound(
        { operation: 'getBlob', target },
        `Blob ${target} not found.`,
        'Store it with putBlob(key, data), or catch NotFoundError.',
      );
    }
    throw inbandRefusal(answer, { operation: 'getBlob', target });
  }

  async update(key: string, ops: UpdateOps<T>, opts?: WriteOptions): Promise<Stored<T>> {
    const target = this.#keyTarget(key);
    // Refused here, before a frame exists: a malformed operator document sends nothing (section 3.9).
    const operators = updateFields(ops, { operation: 'update', target, kind: 'write' });
    const answer = await this.#request('update', target, 'UPDATE', 'write', { key, ...operators }, this.#writeOptions(opts));
    if (answer['success'] === true) return answer['doc'] as Stored<T>;
    if (isUpdateMiss(answer)) {
      throw notFound(
        { operation: 'update', target },
        `Cannot update ${target}: no such document.`,
        'Create it with put(key, doc) first; update never creates a document.',
      );
    }
    throw inbandRefusal(answer, { operation: 'update', target });
  }
}

countRefusalsOf(BucketHandle.prototype, (self) => (self as BucketHandle).client.refusalCounter);

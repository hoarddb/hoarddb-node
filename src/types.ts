// SPDX-License-Identifier: Apache-2.0
//
// Every public type of the driver (build doc section 3). This file imports nothing from node:* and
// nothing that does, so the declarations a consumer reads need nothing but the language.

import type { Cursor } from './cursor.js';

/** The options connect() takes, besides a URI (section 3.1). */
export interface ConnectOptions {
  /** Replaces the URI's host list. */
  hosts?: Array<string | { host: string; port?: number }>;
  username?: string;
  /** Never logged, never in toJSON or inspect. */
  password?: string;
  /** A resumption token (handbook auth.md section 3). */
  authToken?: string;
  /** The default database for client.database(). */
  database?: string;
  /** The default bucket for client.defaultBucket(). */
  bucket?: string;
  tls?: TrustOptions;
  pool?: PoolOptions;
  /** Default 10_000. */
  dialTimeoutMs?: number;
  /** Default 30_000. */
  requestTimeoutMs?: number;
  /** Default: none sent (the server's default). */
  writeConcern?: WriteConcern;
  clientName?: string;
  /** Default 'safe'. */
  int64?: 'safe' | 'bigint';
  /** Default: no output. */
  logger?: Logger;
}

export interface TrustOptions {
  /** "SHA256:<64 hex>", positional per host; one applies to all. */
  fingerprints?: string[];
  /** Default ~/.hoarddb/known_servers; false: do not read or write it. */
  knownServersPath?: string | false;
  onUnknownServer?: (server: { host: string; port: number; fingerprint: string }) => boolean | Promise<boolean>;
  /** Verification off; warns on every connection. There is no URI spelling for it. */
  insecure?: { reason: string };
}

export interface PoolOptions {
  /** Point lane, default 4. */
  size?: number;
  /** Bulk lane, default 2. */
  bulkSize?: number;
  /** Default 1_000. */
  maxWaiters?: number;
  /** Default 120_000. */
  idleTimeoutMs?: number;
}

export interface Logger {
  debug(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
}

export type WriteConcern = 'one' | 'majority' | 'all';

/** A client: the handles, the DDL and the listing verbs, and the connection's own facts. */
export interface Client extends AsyncDisposable {
  /** No name: the URI or option default, else ConfigError. */
  database(name?: string): Database;
  /** The database the URI or the `database` option names, else ConfigError; no I/O. */
  defaultDatabase(): Database;
  /** The URI or option default database and bucket, else ConfigError. */
  defaultBucket<T extends object = Doc>(): AnyBucket<T>;
  createDatabase(name: string, opts?: { ifNotExists?: boolean } & OpOptions): Promise<void>;
  dropDatabase(name: string, opts?: OpOptions): Promise<void>;
  listDatabases(opts?: OpOptions): Promise<DatabaseInfo[]>;
  ping(opts?: OpOptions): Promise<void>;
  health(opts?: OpOptions): Promise<Health>;
  listNodes(opts?: OpOptions): Promise<NodeInfo[]>;
  /** From AUTH; no round trip. */
  serverInfo(): ServerInfo;
  /** Aggregate counters; never per bucket. */
  poolStats(): PoolStats;
  /** Idempotent. Waits for in-flight calls up to timeoutMs (default 5_000), then destroys every socket. */
  close(opts?: { timeoutMs?: number }): Promise<void>;
  [Symbol.asyncDispose](): Promise<void>;
}

export interface Database {
  readonly name: string;
  createBucket<T extends object = Doc>(name: string, type: 'hash', opts?: CreateBucketOptions): Promise<HashBucket<T>>;
  createBucket<T extends object = Doc>(name: string, type: 'btree', opts?: CreateBucketOptions): Promise<BTreeBucket<T>>;
  createBucket<T extends object = Doc>(name: string, type: 'fifo', opts?: CreateBucketOptions): Promise<FifoBucket<T>>;
  createBucket<T extends object = Doc>(name: string, type: 'lifo', opts?: CreateBucketOptions): Promise<LifoBucket<T>>;
  createBucket<T extends object = Doc>(name: string, type: 'heap', opts?: CreateBucketOptions): Promise<HeapBucket<T>>;
  createBucket(name: string, type: 'blob', opts?: CreateBucketOptions): Promise<BlobBucket>;
  dropBucket(name: string, opts?: OpOptions): Promise<void>;
  /** One frame, no paging: an operator call. */
  listBuckets(opts?: OpOptions): Promise<BucketInfo[]>;
  declareStoreFields(bucket: string, stores: StoreSpec[], opts?: OpOptions): Promise<void>;
  /**
   * Changes how many copies of a bucket a cluster keeps. Needs the bucket_rf capability, else
   * UnsupportedFeatureError, nothing sent. The answer comes when the bucket's owner has recorded the
   * change, not when the copies exist: `pending` and `releasing` name the members copying or giving up
   * the bucket. A refusal an operator must act on (a factor larger than the cluster) is an
   * InvalidArgumentError carrying the server's sentence and is sent once; one a retry clears is an
   * UnavailableError with writeOutcome `not_applied` and `retryable` true, which the driver resends
   * with backoff until the call's deadline. Pass `timeoutMs` or `signal` to bound the waiting.
   */
  alterBucket(name: string, opts: AlterBucketOptions): Promise<AlterBucketResult>;
  bucket<T extends object = Doc>(name: string): AnyBucket<T>;
  hash<T extends object = Doc>(name: string): HashBucket<T>;
  btree<T extends object = Doc>(name: string): BTreeBucket<T>;
  fifo<T extends object = Doc>(name: string): FifoBucket<T>;
  lifo<T extends object = Doc>(name: string): LifoBucket<T>;
  heap<T extends object = Doc>(name: string): HeapBucket<T>;
  blob(name: string): BlobBucket;
  /** One BUCKET_STATS round trip. */
  open<T extends object = Doc>(name: string, opts?: OpOptions): Promise<OpenedBucket<T>>;
}

export type StoreType = 'hash' | 'btree' | 'fifo' | 'lifo' | 'heap' | 'blob';

export interface CreateBucketOptions extends OpOptions {
  ifNotExists?: boolean;
  encrypted?: boolean;
  /** Needs the bucket_rf capability, else UnsupportedFeatureError, nothing sent. */
  replicationFactor?: number;
  /** Store fields. */
  stores?: StoreSpec[];
  /** Hash buckets only; the server refuses others. */
  indexes?: IndexSpec[];
  fieldTypes?: { mode?: 'strict' | 'warn' | 'off'; fields: FieldSpec[] };
}

export interface AlterBucketOptions extends OpOptions {
  /** How many copies the cluster keeps from now on: a whole number, at least 1. */
  replicationFactor: number;
}

/** The server's answer to an accepted alterBucket. */
export interface AlterBucketResult {
  /** The server's sentence: what changed, and the command that shows the copies arriving. */
  message: string;
  /** The factor the bucket now asks for, and the one it asked for before; equal when nothing changed. */
  replicationFactor: number;
  previousFactor: number;
  /** The members an increase newly places: they copy the bucket by themselves. Absent when none. */
  pending?: string[];
  /** The members a decrease un-places: their copies are deleted once the others hold everything. Absent when none. */
  releasing?: string[];
}

export interface StoreSpec {
  name: string;
  type: StoreType;
  stores?: StoreSpec[];
}

export interface IndexSpec {
  fields: string[];
  unique?: boolean;
  name?: string;
  expireAfterSeconds?: number;
}

export interface FieldSpec {
  name: string;
  type: string;
  required?: boolean;
  members?: FieldSpec[];
  elem?: Omit<FieldSpec, 'name'>;
}

/** A document value: operand documents (`$push`, `metadata`, `raw`) and the default type argument. */
export type Doc = Record<string, unknown>;

// Every typed handle is bound `T extends object`, not `T extends Doc`: a TypeScript `interface` has no
// implicit index signature, so `interface User { name: string }` does not satisfy `Record<string, unknown>`
// (TS2344) while it does satisfy `object` (owner Q-12). `keyof T & string` still gives the field names.
export type Stored<T extends object> = T & { _id_: string };

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

/** A stored BSON value with no JavaScript form. Written back byte for byte; not constructible in v1. */
export interface Opaque {
  readonly bsonType: OpaqueType;
  readonly bytes: Uint8Array;
}

export interface OpOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface WriteOptions extends OpOptions {
  writeConcern?: WriteConcern;
}

export interface ReadOptions extends OpOptions {
  consistent?: boolean;
}

/** 1..1000, default 1. */
export interface PeekOptions extends OpOptions {
  limit?: number;
}

/**
 * A pop consumes, so it takes the write options. `limit` is how many entries this one request removes
 * at most: a whole number from 1 to 100, default 1.
 */
export interface PopOptions extends WriteOptions {
  limit?: number;
}

/**
 * A claim takes entries under a lease, so it is a write and takes the write options. `limit` is how many
 * entries one claim takes at most (a whole number from 1 to 100, default 1); `lease` is how long the
 * claim holds them, in milliseconds (1000 to 3600000, default 30000).
 */
export interface ClaimOptions extends WriteOptions {
  limit?: number;
  lease?: number;
}

/** `itemIds` acknowledges only those entries (at most 100); without it an ack settles the whole lease. */
export interface AckOptions extends WriteOptions {
  itemIds?: readonly string[];
}

/** `limit` is 1 to 1000 (default 10); `after` is the `next` of the page before, which is not repeated. */
export interface DeadListOptions extends OpOptions {
  limit?: number;
  after?: string;
}

/**
 * Where a lease stands after an ack, release or extend. A word a newer server adds arrives unchanged
 * instead of failing the call.
 */
export type LeaseState = 'acked' | 'released' | 'extended' | 'expired' | 'unknown' | (string & {});

/** One claimed entry. */
export interface Delivery<T extends object = Doc> {
  /** The handle `ack` names. It is not the document's `_id_`. */
  readonly itemId: string;
  readonly document: Stored<T>;
  /** At least how many times this entry has been claimed, counting this one: 1 on the first. */
  readonly deliveries: number;
  /**
   * Moves the whole lease's deadline to now plus `ms` (1000 to 3600000) and resolves to the length the
   * server granted. It extends every entry of the lease, not only this one. Inside a `consume` handler it
   * also moves the handler deadline of the batch.
   */
  extend(ms: number, opts?: WriteOptions): Promise<number>;
}

/** What one claim took. */
export interface Claimed<T extends object = Doc> {
  /** The 40 hexadecimal characters the server uses (empty when nothing was taken). Keep it to ack from another process or after a restart. */
  readonly leaseId: string;
  /** The length of the lease, in milliseconds. Compute a handler deadline from it and this process's own clock. */
  readonly grantedMs: number;
  /** In pop order; empty when there was nothing to take. */
  readonly items: Delivery<T>[];
  /** Entries held under a lease and on the dead list after this claim; 0 when none. */
  readonly pending: number;
  readonly dead: number;
  /** Expired leases this claim gave back. More than 0 with no items means entries are available again: claim again at once. */
  readonly returned: number;
}

/** What an ack did. Counts the server left out are 0. */
export interface AckResult {
  readonly state: LeaseState;
  /** Entries removed. */
  readonly acked: number;
  /** Ids that named nothing the lease holds. */
  readonly missing: number;
  /** Entries still under the lease. */
  readonly remaining: number;
  /** The server's sentence, set when the lease was unknown or expired. */
  readonly message: string;
}

/** What a release did. */
export interface ReleaseResult {
  readonly state: LeaseState;
  /** Entries that went back to the queue at once. */
  readonly released: number;
  readonly message: string;
}

/** One entry on the dead list. */
export interface DeadEntry<T extends object = Doc> {
  /** The handle `requeue` and `discard` name, and what `after` pages by. */
  readonly deadId: string;
  readonly document: T;
  /** How many times the entry was delivered before it died. */
  readonly deliveries: number;
  readonly deadAt: Date;
  /** Why it died: `max_deliveries` or `collided`. */
  readonly reason: string;
}

/** One page of the dead list. */
export interface DeadPage<T extends object = Doc> {
  /** In dead-list order; empty when there are none. */
  readonly items: DeadEntry<T>[];
  /** The last dead id listed, when more remain: pass it as `after` for the next page. Absent on the last page. */
  readonly next?: string;
}

/**
 * Which dead entries a `requeue` or `discard` moves: one by its dead id, or `all` of them. One request
 * considers at most 100 entries, so repeat an `all` request while `done` is above 0; `after` (a dead id,
 * exclusive) steps past entries a request left behind. The server refuses `after` on a `byId` selector.
 */
export type DeadSelector = { byId: string; after?: string } | { all: true; after?: string };

/** One dead entry a requeue left where it was, and why. */
export interface DeadRefusal {
  readonly deadId: string;
  readonly message: string;
}

/** What a requeue or discard did. */
export interface DeadMoveResult {
  /** Entries that moved. */
  readonly done: number;
  /** Entries still on the dead list after an `all` request. */
  readonly left: number;
  /** The entries that stayed, for example a heap element whose key a live element holds. */
  readonly refused: DeadRefusal[];
  readonly message: string;
}

/** `limit` is how many entries one claim takes (default 10); `lease` how long it holds them, in ms (default 30000). */
export interface ConsumeOptions {
  limit?: number;
  lease?: number;
  /** Stops the loop: what it has not acknowledged is released, and `consume` rejects with `AbortedError`. */
  signal?: AbortSignal;
}

/**
 * Runs for one entry. Its `signal` ends at the handler deadline (the lease minus a margin) or when the
 * loop stops; a handler must return when it does. Resolving acknowledges the entry; throwing does not.
 */
export type ConsumeHandler<T extends object = Doc> = (delivery: Delivery<T>, signal: AbortSignal) => void | Promise<void>;

/** Heap only; default 0. */
export interface PushOptions extends WriteOptions {
  priority?: number | bigint;
}

export interface FindOptions<T extends object = Doc> extends OpOptions {
  /** Exactly one field, else InvalidArgumentError locally. */
  sort?: { [K in keyof T & string]?: 1 | -1 };
  projection?: { [K in keyof T & string]?: 0 | 1 };
  skip?: number;
  /** Total across pages; omitted: all. */
  limit?: number;
  /** Default 100. */
  pageSize?: number;
}

export interface RangeOptions extends OpOptions {
  limit?: number;
  pageSize?: number;
}

/** Default 100. */
export interface SearchOptions extends OpOptions {
  /** The most results a search returns (default 100); it returns no more and does not page. */
  limit?: number;
}

/** pageSize at most 1000. */
export interface ListOptions extends OpOptions {
  limit?: number;
  pageSize?: number;
}

export interface BlobWriteOptions extends WriteOptions {
  metadata?: Doc;
}

export interface WriteResult {
  id: string;
  seq?: number | bigint;
  copiesConfirmed?: number;
  replicationFactor?: number;
}

export interface BatchResult {
  ids: string[];
  count: number;
  copiesConfirmed?: number;
  replicationFactor?: number;
}

export interface Entry<T extends object> {
  key: string;
  value: Stored<T>;
}

export interface Blob {
  key: string;
  blobId: string;
  size: number;
  data: Uint8Array;
  metadata: Doc;
}

export interface BlobWriteResult {
  key: string;
  blobId: string;
  size: number;
  copiesConfirmed?: number;
  replicationFactor?: number;
}

export interface DatabaseInfo {
  name: string;
  bucketCount: number;
}

/**
 * A bucket's copies as its owner sees them (handbook operations.md section 3), on `listBuckets()` and
 * `info()`. Every member is absent from a server that does not send it.
 */
export interface BucketCopies {
  /** The copies in sync: the owner plus the members whose stream is not stalled. */
  inSync?: number;
  /**
   * `ok`, `copying`, `under-replicated`, `owner-elsewhere` or `standalone`, as sent: a word a newer
   * server adds arrives unchanged, so treat any word you do not know as opaque.
   */
  state?: string;
  /** The members that do not hold a current copy; absent when none are named. */
  notInSync?: string[];
  /** The members still to receive their copy; absent when none are. */
  pendingCopies?: PendingCopy[];
}

/** A member still to receive a bucket's copy. */
export interface PendingCopy {
  /** The member's node id. */
  node: string;
  /** Unix seconds on the owner's clock when the copy was queued. */
  since: number;
}

export interface BucketInfo extends BucketCopies {
  name: string;
  type: StoreType;
  entries: number;
  stores: string[];
  replicationFactor?: number;
  inherited?: boolean;
}

/** A bucket's declaration, from `bucket.info()`. */
export interface BucketDeclaration extends BucketCopies {
  name: string;
  /** The bucket's own store type. */
  type: StoreType;
  /** The bucket's own document count, not its store fields' elements. */
  entries: number;
  /** The declared top-level store field names, in declaration order; empty when there are none. */
  stores: string[];
  /** The same fields with what each is, in the same order; empty when there are none. */
  storeFields: StoreFieldInfo[];
  /** Absent when the server sent none. */
  replicationFactor?: number;
  /** Whether the replication factor comes from the database; absent when the server did not say. */
  inherited?: boolean;
}

/** One declared store field. */
export interface StoreFieldInfo {
  name: string;
  /**
   * The wire's engine word as sent: `hash`, `btree`, `fifo`, `lifo`, `heap` or `blob` (no `Store`
   * suffix). A word a newer server adds arrives unchanged: treat any word you do not know as opaque.
   */
  engine: string;
}

export interface BucketStats extends BucketCopies {
  database: string;
  bucket: string;
  type: StoreType;
  entries: number;
  raw: Doc;
}

export interface Health {
  nodeId: string;
  version: string;
  healthy: boolean;
  bucketCount: number;
  membership?: string;
  /** The machine the node runs on, for display; undefined from a server older than the field. */
  host?: HostFacts;
  raw: Doc;
}

/**
 * What a node says about its machine in `health()`. Facts for display: a driver never decides anything
 * from them. Every member but `cpus` is absent when the node cannot read it (an idle load of 0 is still
 * present).
 */
export interface HostFacts {
  /** The CPUs the process may use; a container's CPU quota rounds up and caps it. */
  cpus: number;
  /** The machine's CPUs, present only when a container limit lowered `cpus`. */
  hostCpus?: number;
  /** The container's memory limit when one below the machine's is set, else the machine's memory. */
  memoryTotalBytes?: number;
  /** Memory in use within that scope, not counting reclaimable file cache. */
  memoryUsedBytes?: number;
  /** Where `memoryTotalBytes` came from: `cgroup` (a container limit) or `host`. */
  memorySource?: string;
  /** The machine's load average. */
  load?: HostLoad;
}

/** The machine's load average over three windows. */
export interface HostLoad {
  oneMinute: number;
  fiveMinutes: number;
  fifteenMinutes: number;
}

export interface NodeInfo {
  nodeId: string;
  addr: string;
  fingerprint: string;
  joinedAt: Date;
  status: string;
}

export interface ServerInfo {
  version: string;
  protocolVersion: number;
  capabilities: ReadonlySet<string>;
  passwordMinLength?: number;
}

export interface LaneStats {
  open: number;
  inUse: number;
  waiting: number;
}

export interface PoolStats {
  point: LaneStats;
  bulk: LaneStats;
  requests: number;
  retries: number;
  errors: Record<string, number>;
}

export type Filter<T> =
  | { [K in keyof T & string]?: T[K] | FieldOps<T[K]> }
  | { $and: Filter<T>[] }
  | { $or: Filter<T>[] };

export interface FieldOps<V> {
  $gt?: V;
  $gte?: V;
  $lt?: V;
  $lte?: V;
  $ne?: V;
  $in?: V[];
  $nin?: V[];
  $exists?: boolean;
  $regex?: string;
}

/** The nine update operators (section 3.9). Every key may be a path: "Address.City", "Lines[3].Qty". */
export interface UpdateOps<T> {
  /** Sets each value. */
  $set?: Partial<T> & Doc;
  /** A LIST of field names, not a document. */
  $unset?: readonly string[];
  /** Whole numbers that fit in 64 bits; sent as int64. */
  $inc?: Record<string, number | bigint>;
  /** Appends one value to each array. */
  $push?: Doc;
  /** Appends unless an equal value is already there. */
  $addToSet?: Doc;
  /** Finite numbers, fractions allowed; sent as doubles. */
  $mul?: Record<string, number>;
  /** Keeps the smaller of stored and given. */
  $min?: Doc;
  /** Keeps the larger of stored and given. */
  $max?: Doc;
  /** Old name to new name (both strings). */
  $rename?: Record<string, string>;
}

export interface BucketBase {
  readonly database: string;
  readonly name: string;
  stats(opts?: OpOptions): Promise<BucketStats>;
  /**
   * What the bucket is declared as: its type, entry count and top-level store fields, in one round
   * trip. It never walks a store, so it costs the same whatever the stores hold (use `stats()` for
   * element counts). Read-only, so a lost connection is retried once. A bucket or database that does
   * not exist is `NOT_FOUND`; a caller without read permission is `PERMISSION_DENIED`. Nothing is cached
   * on the handle: the next call asks the server again.
   */
  info(opts?: OpOptions): Promise<BucketDeclaration>;
  drop(opts?: OpOptions): Promise<void>;
}

export interface DocumentBucket<T extends object> extends BucketBase {
  count(filter?: Filter<T>, opts?: OpOptions): Promise<number>;
  /**
   * A cursor over the matching documents. It is not a snapshot: each page is a new scan, so a document
   * inserted or deleted between pages can show twice or be missed (handbook operations.md section 3).
   * `cursor.total` is the server's exact match count, from the first page.
   */
  find(filter?: Filter<T>, opts?: FindOptions<T>): Cursor<Stored<T>>;
  /** Throws `NotFoundError` on a miss, so a miss and a stored null are never confused. */
  findOne(filter?: Filter<T>, opts?: OpOptions): Promise<Stored<T>>;
  distinct(field: keyof T & string, filter?: Filter<T>, opts?: OpOptions): Promise<unknown[]>;
}

export interface KeyedBucket<T extends object> extends DocumentBucket<T> {
  put(key: string, doc: T, opts?: WriteOptions): Promise<WriteResult>;
  insert(doc: T, opts?: WriteOptions): Promise<WriteResult>;
  insertMany(docs: readonly (T & { _id_?: string })[], opts?: WriteOptions): Promise<BatchResult>;
  /** Throws `NotFoundError` on a miss, so a miss and a stored null are never confused. */
  get(key: string, opts?: ReadOptions): Promise<Stored<T>>;
  exists(key: string, opts?: OpOptions): Promise<boolean>;
  delete(key: string, opts?: WriteOptions): Promise<boolean>;
  /** Throws `NotFoundError` on a miss, so a miss and a stored null are never confused. */
  update(key: string, ops: UpdateOps<T>, opts?: WriteOptions): Promise<Stored<T>>;
  field<E extends object = Doc>(key: string, field: string): FieldStore<E>;
}

export interface HashBucket<T extends object = Doc> extends KeyedBucket<T> {
  readonly type: 'hash';
  /**
   * One page of at most `limit` results (default 100), through a secondary index when one fits, else by
   * a full scan. `cursor.total` is the number of results returned, not the number of matches;
   * `cursor.hasMore` says whether more matches exist beyond `limit` (raise `limit`, or use `find` when
   * the count matters). A search does not page.
   */
  search(filter: Filter<T>, opts?: SearchOptions): Cursor<Stored<T>>;
}

export interface BTreeBucket<T extends object = Doc> extends KeyedBucket<T> {
  readonly type: 'btree';
  range(bounds: { gte?: string; lte?: string }, opts?: RangeOptions): Cursor<Entry<T>>;
  /** Throws `NotFoundError` on a miss, so a miss and a stored null are never confused. */
  first(opts?: OpOptions): Promise<Entry<T>>;
  /** Throws `NotFoundError` on a miss, so a miss and a stored null are never confused. */
  last(opts?: OpOptions): Promise<Entry<T>>;
}

/** The lease and dead-list verbs of the three ordered stores (fifo, lifo, heap); a store field has none. */
export interface LeaseVerbs<T extends object> {
  /**
   * Takes up to `limit` entries (1 to 100, default 1) in pop order under a lease of `lease` milliseconds
   * (1000 to 3600000, default 30000) and leaves them in the store, invisible to `pop`, `peek` and `find`
   * until the lease runs out, is released or is acknowledged. At-least-once: an entry whose lease runs out
   * is delivered again, and after 5 deliveries without an ack it is dead-lettered (see `deadList`).
   * Nothing to take is a `Claimed` with no items, not an error; `returned` above 0 with no items means
   * expired leases went back and the caller claims again at once. A claim is never resent after a lost
   * answer (it costs one lease of delay). An entry over the hard cap at the front is
   * `ClaimEntryTooLargeError`; only `pop` unblocks the queue.
   */
  claim(opts?: ClaimOptions): Promise<Claimed<T>>;
  /**
   * Removes the claimed entries `itemIds` names, or every entry of the lease when it names none. A lease
   * nothing holds is `LeaseUnknownError` and one whose time ran out is `LeaseExpiredError`, each carrying
   * the result. Never resent after a lost answer: that costs a redelivery, never an entry.
   */
  ack(leaseId: string, opts?: AckOptions): Promise<AckResult>;
  /** Gives every entry of the lease back to the queue at once. Errors as `ack`. */
  release(leaseId: string, opts?: WriteOptions): Promise<ReleaseResult>;
  /** Moves the lease's deadline to now plus `ms` (1000 to 3600000) and resolves to the length GRANTED. Errors as `ack`. */
  extend(leaseId: string, ms: number, opts?: WriteOptions): Promise<number>;
  /**
   * Claims, runs `handler` for each entry and acknowledges the ones whose handler resolved, until
   * `signal` aborts or a failure waiting will not cure. See `ConsumeOptions` and `ConsumeHandler`; the
   * handlers of a batch run at the same time, and `consume` waits for them before it settles.
   * It backs off and goes on after UNAVAILABLE (a lost connection included), TIMEOUT and OVERLOADED on a
   * claim or an ack, and after an ack of an expired or unknown lease. It ends, rejecting with the error,
   * on INVALID_ARGUMENT (`ClaimEntryTooLargeError`, a bad option, a store type with no order),
   * PERMISSION_DENIED, NOT_FOUND, INTERNAL and any other error.
   */
  consume(handler: ConsumeHandler<T>, opts?: ConsumeOptions): Promise<void>;
  /** One page of the bucket's dead entries (limit 1 to 1000, default 10). A read; an empty list is an empty page. */
  deadList(opts?: DeadListOptions): Promise<DeadPage<T>>;
  /** Moves dead entries back into the queue to be delivered again. Never resent. A refusal is `DeadMoveRefusedError` carrying the result. */
  requeue(selector: DeadSelector, opts?: WriteOptions): Promise<DeadMoveResult>;
  /** Drops dead entries for good. Results and errors are `requeue`'s. */
  discard(selector: DeadSelector, opts?: WriteOptions): Promise<DeadMoveResult>;
}

export interface QueueBucket<T extends object> extends DocumentBucket<T>, LeaseVerbs<T> {
  push(doc: T, opts?: WriteOptions): Promise<WriteResult>;
  /**
   * Removes up to `limit` entries (1 to 100, default 1) in one request and returns them in pop order;
   * `[]` when there was nothing to remove. Never retried: a lost answer is an outcome-unknown error
   * saying the pop may have removed up to `limit` entries, and `peek` shows what is left.
   */
  pop(opts?: PopOptions): Promise<Stored<T>[]>;
  peek(opts?: PeekOptions): Promise<Stored<T>[]>;
}

export interface FifoBucket<T extends object = Doc> extends QueueBucket<T> {
  readonly type: 'fifo';
}

export interface LifoBucket<T extends object = Doc> extends QueueBucket<T> {
  readonly type: 'lifo';
}

export interface HeapBucket<T extends object = Doc> extends DocumentBucket<T>, LeaseVerbs<T> {
  readonly type: 'heap';
  push(doc: T, opts?: PushOptions): Promise<WriteResult>;
  /**
   * Removes up to `limit` entries (1 to 100, default 1) in one request and returns them in pop order;
   * `[]` when there was nothing to remove. Never retried: a lost answer is an outcome-unknown error
   * saying the pop may have removed up to `limit` entries, and `peek` shows what is left.
   */
  pop(opts?: PopOptions): Promise<Stored<T>[]>;
  peek(opts?: PeekOptions): Promise<Stored<T>[]>;
}

export interface BlobBucket extends BucketBase {
  readonly type: 'blob';
  putBlob(key: string, data: Uint8Array, opts?: BlobWriteOptions): Promise<BlobWriteResult>;
  /** Throws `NotFoundError` on a miss, so a miss and a stored null are never confused. */
  getBlob(key: string, opts?: OpOptions): Promise<Blob>;
  delete(key: string, opts?: WriteOptions): Promise<boolean>;
  count(opts?: OpOptions): Promise<number>;
}

/** Every verb of every store type; the server refuses a verb the bucket's type does not answer. */
export interface AnyBucket<T extends object = Doc> extends KeyedBucket<T>, LeaseVerbs<T> {
  readonly type: StoreType | undefined;
  /**
   * One page of at most `limit` results (default 100), through a secondary index when one fits, else by
   * a full scan. `cursor.total` is the number of results returned, not the number of matches;
   * `cursor.hasMore` says whether more matches exist beyond `limit` (raise `limit`, or use `find` when
   * the count matters). A search does not page.
   */
  search(filter: Filter<T>, opts?: SearchOptions): Cursor<Stored<T>>;
  range(bounds: { gte?: string; lte?: string }, opts?: RangeOptions): Cursor<Entry<T>>;
  /** Throws `NotFoundError` on a miss, so a miss and a stored null are never confused. */
  first(opts?: OpOptions): Promise<Entry<T>>;
  /** Throws `NotFoundError` on a miss, so a miss and a stored null are never confused. */
  last(opts?: OpOptions): Promise<Entry<T>>;
  push(doc: T, opts?: PushOptions): Promise<WriteResult>;
  /**
   * Removes up to `limit` entries (1 to 100, default 1) in one request and returns them in pop order;
   * `[]` when there was nothing to remove. Never retried: a lost answer is an outcome-unknown error
   * saying the pop may have removed up to `limit` entries, and `peek` shows what is left.
   */
  pop(opts?: PopOptions): Promise<Stored<T>[]>;
  peek(opts?: PeekOptions): Promise<Stored<T>[]>;
  putBlob(key: string, data: Uint8Array, opts?: BlobWriteOptions): Promise<BlobWriteResult>;
  /** Throws `NotFoundError` on a miss, so a miss and a stored null are never confused. */
  getBlob(key: string, opts?: OpOptions): Promise<Blob>;
}

export type OpenedBucket<T extends object = Doc> =
  | HashBucket<T>
  | BTreeBucket<T>
  | FifoBucket<T>
  | LifoBucket<T>
  | HeapBucket<T>
  | BlobBucket;

export interface FieldEntry<E extends object = Doc> {
  element: E | null;
  elementKey?: string;
  position?: number;
  priority?: number | bigint;
  entryId?: string;
  blobId?: string;
}

export interface FieldWriteResult {
  entryId?: string;
  elementKey?: string;
  position?: number;
  priority?: number | bigint;
  blobId?: string;
  copiesConfirmed?: number;
  replicationFactor?: number;
}

export interface FieldBlob {
  elementKey: string;
  blobId: string;
  data: Uint8Array;
  metadata: Doc;
}

export interface FieldStore<E extends object = Doc> {
  /** The parent document's key. */
  readonly key: string;
  /** The store field's name on the parent document (not `field`: that name is the accessor below). */
  readonly fieldName: string;
  /** A store nested in an element; no I/O. */
  field<F extends object = Doc>(element: string, field: string): FieldStore<F>;
  /** Fifo, lifo, heap. */
  push(doc: E, opts?: PushOptions): Promise<FieldWriteResult>;
  /** As a bucket's `pop`: up to `limit` entries (1 to 100, default 1), in pop order; `[]` when empty. */
  pop(opts?: PopOptions): Promise<FieldEntry<E>[]>;
  peek(opts?: PeekOptions): Promise<FieldEntry<E>[]>;
  /** Hash, btree. */
  put(element: string, doc: E, opts?: WriteOptions): Promise<FieldWriteResult>;
  /** Throws `NotFoundError` on a miss, so a miss and a stored null are never confused. */
  get(element: string, opts?: OpOptions): Promise<FieldEntry<E>>;
  delete(element: string, opts?: WriteOptions): Promise<boolean>;
  putBlob(element: string, data: Uint8Array, opts?: BlobWriteOptions): Promise<FieldWriteResult>;
  /** Throws `NotFoundError` on a miss, so a miss and a stored null are never confused. */
  getBlob(element: string, opts?: OpOptions): Promise<FieldBlob>;
  len(opts?: OpOptions): Promise<number>;
  list(opts?: ListOptions): Cursor<FieldEntry<E>>;
}

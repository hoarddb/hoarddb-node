// SPDX-License-Identifier: Apache-2.0
//
// A database handle (section 3.2). Like a bucket handle it holds a client and a name and does no I/O
// until a verb is called. The DDL and listing verbs that name a database build their requests here.

import { AlreadyExistsError, InvalidArgumentError } from './errors.js';
import type { CallSpec } from './call.js';
import type { ClientImpl } from './client-core.js';
import { BucketHandle, copiesOf, facet, refusedInBand } from './bucket.js';
import { countRefusalsOf } from './refusals.js';
import type {
  AlterBucketOptions,
  AlterBucketResult,
  AnyBucket,
  BlobBucket,
  BTreeBucket,
  BucketInfo,
  CreateBucketOptions,
  Database,
  Doc,
  FifoBucket,
  HashBucket,
  HeapBucket,
  IndexSpec,
  LifoBucket,
  OpenedBucket,
  OpOptions,
  StoreSpec,
  StoreType,
} from './types.js';

/** The bucket-declaration wire shape of section 2 (D-18): stores nest as the server names them. */
function wireStores(stores: StoreSpec[]): Record<string, unknown>[] {
  return stores.map((store) => ({
    name: store.name,
    engine: store.type,
    fields: store.stores === undefined ? undefined : wireStores(store.stores),
  }));
}

function wireIndexes(indexes: IndexSpec[]): Record<string, unknown>[] {
  return indexes.map((index) => ({
    fields: index.fields,
    unique: index.unique,
    name: index.name,
    expire_after_seconds: index.expireAfterSeconds,
  }));
}

/** The options object CREATE_BUCKET carries, present only when a declaration was given. */
function declarationOf(opts: CreateBucketOptions | undefined): Record<string, unknown> | undefined {
  if (opts === undefined || (opts.stores === undefined && opts.indexes === undefined && opts.fieldTypes === undefined)) {
    return undefined;
  }
  return {
    stores: opts.stores === undefined ? undefined : wireStores(opts.stores),
    indices: opts.indexes === undefined ? undefined : wireIndexes(opts.indexes),
    fields: opts.fieldTypes?.fields,
    field_types: opts.fieldTypes?.mode,
  };
}

/** The message the server gives when a bucket of the same type already exists (handbook errors.md). */
const SAME_TYPE_EXISTS = /^bucket ".*" already exists \(type: /;

export class DatabaseHandle implements Database {
  // The client is held in an ES private field: inspect and JSON never walk from a handle to it.
  readonly #client: ClientImpl;

  constructor(
    client: ClientImpl,
    readonly name: string,
  ) {
    this.#client = client;
  }

  /** The client behind the handle. A getter, so inspect does not walk it. */
  get client(): ClientImpl {
    return this.#client;
  }

  createBucket<T extends object = Doc>(name: string, type: 'hash', opts?: CreateBucketOptions): Promise<HashBucket<T>>;
  createBucket<T extends object = Doc>(name: string, type: 'btree', opts?: CreateBucketOptions): Promise<BTreeBucket<T>>;
  createBucket<T extends object = Doc>(name: string, type: 'fifo', opts?: CreateBucketOptions): Promise<FifoBucket<T>>;
  createBucket<T extends object = Doc>(name: string, type: 'lifo', opts?: CreateBucketOptions): Promise<LifoBucket<T>>;
  createBucket<T extends object = Doc>(name: string, type: 'heap', opts?: CreateBucketOptions): Promise<HeapBucket<T>>;
  createBucket(name: string, type: 'blob', opts?: CreateBucketOptions): Promise<BlobBucket>;
  createBucket(name: string, type: StoreType, opts?: CreateBucketOptions): Promise<unknown> {
    return this.#createBucketOf(name, type, opts);
  }

  async dropBucket(name: string, opts?: OpOptions): Promise<void> {
    const target = `${this.name}/${name}`;
    const answer = await this.#client.send({
      operation: 'dropBucket',
      target,
      op: 'DELETE_BUCKET',
      fields: { database: this.name, name },
      lane: 'point',
      kind: 'ddl',
      opts,
    });
    if (answer['success'] !== true) throw refusedInBand(answer, 'dropBucket', target);
  }

  async listBuckets(opts?: OpOptions): Promise<BucketInfo[]> {
    const answer = await this.#client.send({
      operation: 'listBuckets',
      target: this.name,
      op: 'LIST_BUCKETS',
      fields: { database: this.name },
      lane: 'point',
      kind: 'read',
      opts,
    });
    const buckets = (answer['buckets'] ?? []) as Record<string, unknown>[];
    return buckets.map((bucket) => {
      const info: BucketInfo = {
        name: bucket['name'] as string,
        type: bucket['type'] as StoreType,
        entries: Number(bucket['entries']),
        stores: (bucket['stores'] ?? []) as string[],
      };
      if (bucket['replication_factor'] !== undefined) info.replicationFactor = Number(bucket['replication_factor']);
      if (typeof bucket['inherited'] === 'boolean') info.inherited = bucket['inherited'];
      return Object.assign(info, copiesOf(bucket));
    });
  }

  async declareStoreFields(bucket: string, stores: StoreSpec[], opts?: OpOptions): Promise<void> {
    const target = `${this.name}/${bucket}`;
    const answer = await this.#client.send({
      operation: 'declareStoreFields',
      target,
      op: 'DECLARE_STORE_FIELDS',
      fields: { database: this.name, name: bucket, stores: wireStores(stores) },
      lane: 'point',
      kind: 'ddl',
      opts,
    });
    if (answer['success'] !== true) throw refusedInBand(answer, 'declareStoreFields', target);
  }

  async alterBucket(name: string, opts: AlterBucketOptions): Promise<AlterBucketResult> {
    const target = `${this.name}/${name}`;
    const copies = opts.replicationFactor;
    if (!Number.isInteger(copies) || copies < 1) {
      throw new InvalidArgumentError({
        message: `alterBucket replicationFactor is ${String(copies)}; a bucket keeps at least one copy. Pass the number of copies you want, for example alterBucket('${name}', { replicationFactor: 3 }).`,
        operation: 'alterBucket',
        target,
      });
    }
    this.#client.requireCapability('bucket_rf', 'alterBucket', 'alterBucket', target);
    const answer = await this.#client.send({
      operation: 'alterBucket',
      target,
      op: 'ALTER_BUCKET',
      fields: { database: this.name, name, replication_factor: copies },
      lane: 'point',
      kind: 'ddl',
      opts,
    });
    if (answer['success'] !== true) throw refusedInBand(answer, 'alterBucket', target);
    const result: AlterBucketResult = {
      message: typeof answer['message'] === 'string' ? answer['message'] : '',
      replicationFactor: Number(answer['replication_factor']),
      previousFactor: Number(answer['previous_factor']),
    };
    if (Array.isArray(answer['pending'])) result.pending = answer['pending'] as string[];
    if (Array.isArray(answer['releasing'])) result.releasing = answer['releasing'] as string[];
    return result;
  }

  bucket<T extends object = Doc>(name: string): AnyBucket<T> {
    return facet<AnyBucket<T>>(this.#handle(name, undefined));
  }

  hash<T extends object = Doc>(name: string): HashBucket<T> {
    return facet<HashBucket<T>>(this.#handle(name, 'hash'));
  }

  btree<T extends object = Doc>(name: string): BTreeBucket<T> {
    return facet<BTreeBucket<T>>(this.#handle(name, 'btree'));
  }

  fifo<T extends object = Doc>(name: string): FifoBucket<T> {
    return facet<FifoBucket<T>>(this.#handle(name, 'fifo'));
  }

  lifo<T extends object = Doc>(name: string): LifoBucket<T> {
    return facet<LifoBucket<T>>(this.#handle(name, 'lifo'));
  }

  heap<T extends object = Doc>(name: string): HeapBucket<T> {
    return facet<HeapBucket<T>>(this.#handle(name, 'heap'));
  }

  blob(name: string): BlobBucket {
    return facet<BlobBucket>(this.#handle(name, 'blob'));
  }

  async open<T extends object = Doc>(name: string, opts?: OpOptions): Promise<OpenedBucket<T>> {
    const stats = await this.#handle(name, undefined).stats(opts);
    return facet<OpenedBucket<T>>(this.#handle(name, stats.type));
  }

  #handle(name: string, type: StoreType | undefined): BucketHandle {
    return new BucketHandle(this.#client, this.name, name, type);
  }

  async #createBucketOf(name: string, type: StoreType, opts: CreateBucketOptions | undefined): Promise<unknown> {
    const target = `${this.name}/${name}`;
    const fields: Record<string, unknown> = { database: this.name, name, type };
    const declaration = declarationOf(opts);
    if (declaration !== undefined) fields['options'] = declaration;
    if (opts?.encrypted === true) fields['encrypted'] = true;
    if (opts?.replicationFactor !== undefined) {
      this.#client.requireCapability('bucket_rf', 'replicationFactor', 'createBucket', target);
      fields['replication_factor'] = opts.replicationFactor;
    }

    const spec: CallSpec = {
      operation: 'createBucket',
      target,
      op: 'CREATE_BUCKET',
      fields,
      lane: 'point',
      kind: 'ddl',
      opts,
    };
    const answer = await this.#client.send(spec);
    if (answer['success'] !== true) throw refusedInBand(answer, 'createBucket', target);

    const message = typeof answer['message'] === 'string' ? answer['message'] : '';
    if (SAME_TYPE_EXISTS.test(message) && opts?.ifNotExists !== true) {
      throw new AlreadyExistsError({ message, operation: 'createBucket', target });
    }
    return this.#handle(name, type);
  }
}

countRefusalsOf(DatabaseHandle.prototype, (self) => (self as DatabaseHandle).client.refusalCounter);

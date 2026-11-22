// SPDX-License-Identifier: Apache-2.0
//
// A store field of one document (section 3.5; build doc step 14, decision D-17). A field store holds no
// data: it is a key, a field name and a path into the document, and each verb is one request. A store
// nested in an element carries the path to that element, so its requests name the element's own store.

import { HALVING_CURSOR, type BucketHandle } from './bucket.js';
import type { ClientImpl } from './client-core.js';
import { countRefusalsOf } from './refusals.js';
import { Cursor, type PageFetcher } from './cursor.js';
import { InvalidArgumentError, type NotFoundError, type ErrorContext } from './errors.js';
import { inbandRefusal, notFound, peekLimitOf, popLimitOf, priorityOf } from './inband.js';
import type { CallSpec } from './call.js';
import type {
  BlobWriteOptions,
  Doc,
  FieldBlob,
  FieldEntry,
  FieldStore,
  FieldWriteResult,
  ListOptions,
  OpOptions,
  PeekOptions,
  PopOptions,
  PushOptions,
  WriteOptions,
} from './types.js';
import type { OpName } from './wire/opcodes.js';

/** The page size a list asks for when the caller names none (a field list is paged like a scan). */
const DEFAULT_LIST_PAGE = 100;
/** The largest page the server answers to a field list. */
const MAX_LIST_PAGE = 1000;

/** Drops the keys the answer did not carry, so an absent field stays absent on the result. */
function compact<R>(values: Record<string, unknown>): R {
  return Object.fromEntries(Object.entries(values).filter(([, value]) => value !== undefined)) as R;
}

/** One store entry as an answer carries it (a pop, a get, a list entry). */
function entryOf<E extends object>(raw: Record<string, unknown>): FieldEntry<E> {
  return compact<FieldEntry<E>>({
    element: (raw['element'] ?? null) as E | null,
    elementKey: raw['element_key'],
    position: raw['position'] === undefined ? undefined : Number(raw['position']),
    priority: raw['priority'],
    entryId: raw['entry_id'],
    blobId: raw['blob_id'],
  });
}

/** The result of a store write: its entry, key, position, priority, blob and copies, each when present. */
function fieldWriteOf(answer: Record<string, unknown>): FieldWriteResult {
  return compact<FieldWriteResult>({
    entryId: answer['entry_id'],
    elementKey: answer['element_key'],
    position: answer['position'] === undefined ? undefined : Number(answer['position']),
    priority: answer['priority'],
    blobId: answer['blob_id'],
    copiesConfirmed: answer['copies_confirmed'] === undefined ? undefined : Number(answer['copies_confirmed']),
    replicationFactor: answer['replication_factor'] === undefined ? undefined : Number(answer['replication_factor']),
  });
}

/** found true is the entry, found false is a miss (NotFoundError), and anything else is a refusal. */
function entryOrThrow<E extends object>(answer: Record<string, unknown>, ctx: ErrorContext): FieldEntry<E> {
  if (answer['found'] === true) return entryOf<E>(answer);
  if (answer['found'] === false) throw elementMiss(ctx);
  throw inbandRefusal(answer, ctx);
}

function elementMiss(ctx: ErrorContext): NotFoundError {
  return notFound(
    ctx,
    `Element not found in ${String(ctx.target)}.`,
    'Add it with put(element, doc), or catch NotFoundError. A missing parent document or undeclared field is also NOT_FOUND.',
  );
}

export class FieldStoreHandle<E extends object = Doc> implements FieldStore<E> {
  // The bucket handle (and through it the client) is held in an ES private field: inspect and JSON
  // never walk from a field store to the client.
  readonly #bucket: BucketHandle<object>;

  constructor(
    bucket: BucketHandle<object>,
    readonly key: string,
    readonly fieldName: string,
    private readonly path: unknown[],
  ) {
    this.#bucket = bucket;
  }

  /** The client behind the store. A getter, so inspect does not walk it. */
  get client(): ClientImpl {
    return this.#bucket.client;
  }

  field<F extends object = Doc>(element: string, field: string): FieldStore<F> {
    return new FieldStoreHandle<F>(this.#bucket, this.key, field, [...this.path, this.fieldName, element]);
  }

  async push(doc: E, opts?: PushOptions): Promise<FieldWriteResult> {
    const target = this.#target();
    const fields: Record<string, unknown> = { data: doc };
    if (opts?.priority !== undefined) fields['priority'] = priorityOf(opts.priority, target);
    const answer = await this.#send('push', 'FIELD_PUSH', 'write', fields, target, this.#writeOptions(opts));
    if (answer['success'] === false) throw inbandRefusal(answer, { operation: 'push', target });
    return fieldWriteOf(answer);
  }

  async pop(opts?: PopOptions): Promise<FieldEntry<E>[]> {
    const target = this.#target();
    const limit = popLimitOf(opts?.limit, target);
    const fields = limit === undefined ? {} : { limit };
    const answer = await this.#send('pop', 'FIELD_POP', 'write', fields, target, this.#writeOptions(opts));
    // A pop answers a list of entries, as a peek does, in pop order; found: false is an empty store.
    if (answer['found'] === true) return ((answer['items'] ?? []) as Record<string, unknown>[]).map((raw) => entryOf<E>(raw));
    if (answer['found'] === false) return [];
    throw inbandRefusal(answer, { operation: 'pop', target });
  }

  async peek(opts?: PeekOptions): Promise<FieldEntry<E>[]> {
    const target = this.#target();
    const limit = peekLimitOf(opts?.limit, target);
    const answer = await this.#send('peek', 'FIELD_PEEK', 'read', { limit }, target, opts);
    if (answer['success'] === false) throw inbandRefusal(answer, { operation: 'peek', target });
    return ((answer['items'] ?? []) as Record<string, unknown>[]).map((raw) => entryOf<E>(raw));
  }

  async put(element: string, doc: E, opts?: WriteOptions): Promise<FieldWriteResult> {
    const target = this.#target();
    const answer = await this.#send('put', 'FIELD_PUT', 'write', { element, data: doc }, target, this.#writeOptions(opts));
    if (answer['success'] === false) throw inbandRefusal(answer, { operation: 'put', target });
    return fieldWriteOf(answer);
  }

  async get(element: string, opts?: OpOptions): Promise<FieldEntry<E>> {
    const target = this.#target();
    const answer = await this.#send('get', 'FIELD_GET', 'read', { element }, target, opts);
    return entryOrThrow<E>(answer, { operation: 'get', target });
  }

  async delete(element: string, opts?: WriteOptions): Promise<boolean> {
    const target = this.#target();
    const answer = await this.#send('delete', 'FIELD_DELETE', 'write', { element }, target, this.#writeOptions(opts));
    if (answer['found'] === true) return true;
    if (answer['found'] === false) return false;
    throw inbandRefusal(answer, { operation: 'delete', target });
  }

  async putBlob(element: string, data: Uint8Array, opts?: BlobWriteOptions): Promise<FieldWriteResult> {
    const target = this.#target();
    const fields = { element, data: opts?.metadata ?? {}, content: data };
    const answer = await this.#send('putBlob', 'FIELD_PUT', 'write', fields, target, this.#writeOptions(opts), 'bulk');
    if (answer['success'] === false) throw inbandRefusal(answer, { operation: 'putBlob', target });
    return fieldWriteOf(answer);
  }

  async getBlob(element: string, opts?: OpOptions): Promise<FieldBlob> {
    const target = this.#target();
    const answer = await this.#send('getBlob', 'FIELD_GET', 'read', { element }, target, opts, 'bulk');
    if (answer['found'] === true) {
      // A store that is not a blob store answers with its element and no blob: nothing to return.
      if (!(answer['content'] instanceof Uint8Array) || typeof answer['blob_id'] !== 'string') {
        throw new InvalidArgumentError({
          message: `field "${this.fieldName}" of ${target} answered getBlob with no blob: it is not a blob store field. Read it with get(element), or call getBlob on a blobStore field.`,
          operation: 'getBlob',
          target,
        });
      }
      return {
        elementKey: answer['element_key'] as string,
        blobId: answer['blob_id'],
        data: answer['content'],
        metadata: (answer['element'] ?? {}) as Doc,
      };
    }
    if (answer['found'] === false) throw elementMiss({ operation: 'getBlob', target });
    throw inbandRefusal(answer, { operation: 'getBlob', target });
  }

  async len(opts?: OpOptions): Promise<number> {
    const target = this.#target();
    const answer = await this.#send('len', 'FIELD_LEN', 'read', {}, target, opts);
    return Number(answer['len']);
  }

  list(opts?: ListOptions): Cursor<FieldEntry<E>> {
    const target = this.#target();
    /** The opaque position the previous page ended at, passed back unchanged. */
    let after: unknown;
    const fetch: PageFetcher<FieldEntry<E>> = async ({ pageSize }) => {
      const fields: Record<string, unknown> = { limit: Math.min(pageSize, MAX_LIST_PAGE) };
      if (after !== undefined) fields['after'] = after;
      const answer = await this.#send('list', 'FIELD_LIST', 'read', fields, target, opts, 'bulk', HALVING_CURSOR);
      if (answer['success'] === false) throw inbandRefusal(answer, { operation: 'list', target });
      after = answer['next'];
      const entries = (answer['entries'] ?? []) as Record<string, unknown>[];
      return { items: entries.map((raw) => entryOf<E>(raw)), done: answer['has_more'] !== true };
    };
    return new Cursor<FieldEntry<E>>(fetch, {
      pageSize: opts?.pageSize ?? DEFAULT_LIST_PAGE,
      limit: opts?.limit,
      halveOnTooLarge: true,
    });
  }

  /** The address of the parent document, for every error a verb of this store raises. */
  #target(): string {
    return `${this.#bucket.database}/${this.#bucket.name}/${this.key}`;
  }

  /** The write concern a write carries: the call's own, else the client's default (D-19). */
  #writeOptions(opts: WriteOptions | undefined): OpOptions & { writeConcern?: WriteOptions['writeConcern'] } {
    return {
      signal: opts?.signal,
      timeoutMs: opts?.timeoutMs,
      writeConcern: opts?.writeConcern ?? this.#bucket.client.options.writeConcern,
    };
  }

  /** One request on this store: the document, the field, and the path to the store when it is nested. */
  #send(
    operation: string,
    op: OpName,
    kind: CallSpec['kind'],
    fields: Record<string, unknown>,
    target: string,
    opts: OpOptions | undefined,
    lane: CallSpec['lane'] = 'point',
    uncounted?: CallSpec['uncounted'],
  ): Promise<Record<string, unknown>> {
    const base: Record<string, unknown> = {
      database: this.#bucket.database,
      bucket: this.#bucket.name,
      key: this.key,
      field: this.fieldName,
    };
    if (this.path.length > 0) base['path'] = this.path;
    return this.#bucket.client.send({
      operation,
      target,
      op,
      fields: { ...base, ...fields },
      lane,
      kind,
      opts,
      ...(uncounted === undefined ? {} : { uncounted }),
    });
  }
}

countRefusalsOf(FieldStoreHandle.prototype, (self) => (self as FieldStoreHandle).client.refusalCounter);

// SPDX-License-Identifier: Apache-2.0
//
// The client's implementation (build doc step 11). Every verb builds a CallSpec and sends it through
// the dependencies it was given, so the same code runs on a live pool in connect() and on a recording
// call in the request-shape tests. Nothing here is exported from the package's entry point.

import type { CallSpec } from './call.js';
import { ClientClosedError, ConfigError, UnsupportedFeatureError, isHoardDBError } from './errors.js';
import type { Pool } from './pool.js';
import type { ResolvedOptions } from './options.js';
import { DatabaseHandle } from './database.js';
import { BucketHandle, facet, refusedInBand } from './bucket.js';
import { countRefusalsOf } from './refusals.js';
import type { AnyBucket, Client, DatabaseInfo, Doc, Health, HostFacts, HostLoad, NodeInfo, OpOptions, PoolStats, ServerInfo } from './types.js';

/** What a client needs from the world: a call, its options, its server and its pool. */
export interface ClientDeps {
  call: (spec: CallSpec) => Promise<Record<string, unknown>>;
  options: ResolvedOptions;
  serverInfo: () => ServerInfo;
  poolStats: () => PoolStats;
  close: (timeoutMs: number) => Promise<void>;
  /** Absent in recording tests. */
  pool?: Pool;
  /** Counts a refusal a public verb surfaces, once (poolStats().errors). */
  countRefusal?: (error: unknown) => void;
}

/** The deadline close() gives in-flight calls when the caller names none (section 3.2). */
const DEFAULT_CLOSE_TIMEOUT_MS = 5_000;

function clientClosed(operation: string, target: string): ClientClosedError {
  return new ClientClosedError({
    message: 'This client was closed. Create a new one with connect().',
    operation,
    target,
  });
}

export class ClientImpl implements Client {
  // The dependencies hold the pool, whose session holds the password and the token. They live in an
  // ES private field, which util.inspect (at any depth, with showHidden), a console log and
  // JSON.stringify never read, so no public object leads to a secret (build doc step 11).
  readonly #deps: ClientDeps;

  private isClosed = false;
  private closing: Promise<void> | undefined;

  constructor(deps: ClientDeps) {
    this.#deps = deps;
  }

  /** The pool, when a live one stands behind the client. A getter, so inspect does not walk it. */
  get pool(): Pool | undefined {
    return this.#deps.pool;
  }

  /** Counts a refusal a public verb surfaces (src/refusals.ts); a getter, so it is not wrapped itself. */
  get refusalCounter(): ((error: unknown) => void) | undefined {
    return this.#deps.countRefusal;
  }

  /** The options this client was built with. */
  get options(): ResolvedOptions {
    return this.#deps.options;
  }

  /** A feature the server must advertise before a call may carry it; refused before anything is sent. */
  requireCapability(capability: string, option: string, operation: string, target: string): void {
    const info = this.#deps.serverInfo();
    if (info.capabilities.has(capability)) return;
    throw new UnsupportedFeatureError({
      message: `This server (${info.version}) does not advertise "${capability}", so ${option} cannot be honoured. Nothing was sent. Upgrade the server, or leave the option out.`,
      operation,
      target,
    });
  }

  /** Every request a verb makes goes through here: refused once the client is closed, else sent. */
  async send(spec: CallSpec): Promise<Record<string, unknown>> {
    if (this.isClosed) throw clientClosed(spec.operation, spec.target);
    return this.#deps.call(spec);
  }

  database(name?: string): DatabaseHandle {
    const chosen = name ?? this.#deps.options.database;
    if (chosen === undefined) {
      throw new ConfigError('INVALID_OPTIONS', {
        message: 'No database given and none in the connection string; pass a name, or add /<database> to the URI.',
        operation: 'database',
      });
    }
    return new DatabaseHandle(this, chosen);
  }

  defaultDatabase(): DatabaseHandle {
    const database = this.#deps.options.database;
    if (database === undefined) {
      throw new ConfigError('INVALID_OPTIONS', {
        message:
          'No database given and none in the connection string; add it as the path, hoarddb://host/<database>, or use client.database(name).',
        operation: 'defaultDatabase',
      });
    }
    return new DatabaseHandle(this, database);
  }

  defaultBucket<T extends object = Doc>(): AnyBucket<T> {
    const database = this.#deps.options.database;
    const bucket = this.#deps.options.bucket;
    if (database === undefined) {
      throw new ConfigError('INVALID_OPTIONS', {
        message: 'No database given and none in the connection string; pass a name, or add /<database>/<bucket> to the URI.',
        operation: 'defaultBucket',
      });
    }
    if (bucket === undefined) {
      throw new ConfigError('INVALID_OPTIONS', {
        message: 'No bucket given and none in the connection string; pass a name, or add /<database>/<bucket> to the URI.',
        operation: 'defaultBucket',
      });
    }
    return facet<AnyBucket<T>>(new BucketHandle(this, database, bucket, undefined));
  }

  async createDatabase(name: string, opts?: { ifNotExists?: boolean } & OpOptions): Promise<void> {
    const spec: CallSpec = {
      operation: 'createDatabase',
      target: name,
      op: 'CREATE_DB',
      fields: { name },
      lane: 'point',
      kind: 'ddl',
      opts,
      // An ALREADY_EXISTS this call swallows is not one the program sees, so call() does not count it.
      ...(opts?.ifNotExists === true ? { uncounted: ['ALREADY_EXISTS'] as const } : {}),
    };
    try {
      const answer = await this.send(spec);
      if (answer['success'] !== true) throw refusedInBand(answer, spec.operation, name);
    } catch (error) {
      if (opts?.ifNotExists === true && isHoardDBError(error) && error.code === 'ALREADY_EXISTS') return;
      throw error;
    }
  }

  async dropDatabase(name: string, opts?: OpOptions): Promise<void> {
    const answer = await this.send({
      operation: 'dropDatabase',
      target: name,
      op: 'DELETE_DB',
      fields: { name },
      lane: 'point',
      kind: 'ddl',
      opts,
    });
    if (answer['success'] !== true) throw refusedInBand(answer, 'dropDatabase', name);
  }

  async listDatabases(opts?: OpOptions): Promise<DatabaseInfo[]> {
    const answer = await this.send({
      operation: 'listDatabases',
      target: this.serverTarget,
      op: 'LIST_DATABASES',
      fields: {},
      lane: 'point',
      kind: 'read',
      opts,
    });
    const databases = (answer['databases'] ?? []) as Record<string, unknown>[];
    return databases.map((entry) => ({ name: entry['name'] as string, bucketCount: Number(entry['bucketcount']) }));
  }

  async ping(opts?: OpOptions): Promise<void> {
    await this.send({ operation: 'ping', target: this.serverTarget, op: 'PING', fields: {}, lane: 'point', kind: 'read', opts });
  }

  async health(opts?: OpOptions): Promise<Health> {
    const answer = await this.send({
      operation: 'health',
      target: this.serverTarget,
      op: 'HEALTH_CHECK',
      fields: {},
      lane: 'point',
      kind: 'read',
      opts,
    });
    const membership = answer['membership'];
    return {
      nodeId: answer['nodeid'] as string,
      version: answer['version'] as string,
      healthy: answer['healthy'] as boolean,
      bucketCount: Number(answer['bucketcount']),
      membership: typeof membership === 'string' ? membership : undefined,
      host: hostFactsOf(answer['host']),
      raw: answer,
    };
  }

  async listNodes(opts?: OpOptions): Promise<NodeInfo[]> {
    const answer = await this.send({
      operation: 'listNodes',
      target: this.serverTarget,
      op: 'LIST_NODES',
      fields: {},
      lane: 'point',
      kind: 'read',
      opts,
    });
    const nodes = (answer['nodes'] ?? []) as Record<string, unknown>[];
    return nodes.map((node) => ({
      nodeId: node['nodeid'] as string,
      addr: node['addr'] as string,
      fingerprint: node['fingerprint'] as string,
      joinedAt: node['joinedat'] as Date,
      status: node['status'] as string,
    }));
  }

  serverInfo(): ServerInfo {
    return this.#deps.serverInfo();
  }

  /** The address a server-level call names: the first host the client was given. */
  private get serverTarget(): string {
    const [first] = this.#deps.options.hosts;
    return first === undefined ? 'server' : `${first.host}:${first.port}`;
  }

  poolStats(): PoolStats {
    return this.#deps.poolStats();
  }

  close(opts?: { timeoutMs?: number }): Promise<void> {
    if (this.closing === undefined) {
      this.isClosed = true;
      this.closing = this.#deps.close(opts?.timeoutMs ?? DEFAULT_CLOSE_TIMEOUT_MS);
    }
    return this.closing;
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }
}

/** The client the public connect() and the recording tests both build. */
export function createClient(deps: ClientDeps): ClientImpl {
  return new ClientImpl(deps);
}

// Every public verb counts the refusal it surfaces. send and requireCapability are internals the
// handles call; a refusal through them is counted where it leaves the public verb that called them.
countRefusalsOf(ClientImpl.prototype, (self) => (self as ClientImpl).refusalCounter, ['send', 'requireCapability']);

/** A member of the host document as a number (int32, int64 and double all read), or undefined when it is not one. */
function hostNumber(value: unknown): number | undefined {
  return typeof value === 'number' || typeof value === 'bigint' ? Number(value) : undefined;
}

/** The `host` document of a health answer; nothing when the answer has none or it is not a document with a CPU count. */
function hostFactsOf(value: unknown): HostFacts | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const host = value as Record<string, unknown>;
  const cpus = hostNumber(host['cpus']);
  if (cpus === undefined) return undefined;
  const facts: HostFacts = { cpus };
  const hostCpus = hostNumber(host['host_cpus']);
  if (hostCpus !== undefined) facts.hostCpus = hostCpus;
  const total = hostNumber(host['memory_total_bytes']);
  if (total !== undefined) facts.memoryTotalBytes = total;
  const used = hostNumber(host['memory_used_bytes']);
  if (used !== undefined) facts.memoryUsedBytes = used;
  if (typeof host['memory_source'] === 'string') facts.memorySource = host['memory_source'];
  const load = hostLoadOf(host['load']);
  if (load !== undefined) facts.load = load;
  return facts;
}

function hostLoadOf(value: unknown): HostLoad | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const load = value as Record<string, unknown>;
  const oneMinute = hostNumber(load['one_minute']);
  const fiveMinutes = hostNumber(load['five_minutes']);
  const fifteenMinutes = hostNumber(load['fifteen_minutes']);
  if (oneMinute === undefined || fiveMinutes === undefined || fifteenMinutes === undefined) return undefined;
  return { oneMinute, fiveMinutes, fifteenMinutes };
}

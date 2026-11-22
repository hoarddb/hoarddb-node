// SPDX-License-Identifier: Apache-2.0
//
// The options of one client, resolved once (build doc step 11, decision D-26). The precedence is the
// one the public surface states: an option beats the URI, and the URI beats the environment. The
// password and the token never reach inspect() or JSON.stringify() of the resolved options.

import { inspect } from 'node:util';

import type { DialTarget } from './connection.js';
import { ConfigError } from './errors.js';
import type { PoolConfig } from './pool.js';
import { DEFAULT_PORT, parseUri } from './uri.js';
import { makeTrustPolicy, type TrustPolicy } from './trust.js';
import type { Int64Mode } from './codec/index.js';
import type { ConnectOptions, Logger, WriteConcern } from './types.js';

export interface ResolvedOptions {
  hosts: DialTarget[];
  username: string;
  password?: string;
  authToken?: string;
  database?: string;
  bucket?: string;
  trust: TrustPolicy;
  pool: PoolConfig;
  dialTimeoutMs: number;
  requestTimeoutMs: number;
  writeConcern?: WriteConcern;
  clientName?: string;
  int64: Int64Mode;
  logger?: Logger;
}

/** The keys each object of ConnectOptions accepts, sorted as the error names them (section 3.1). */
const CONNECT_KEYS = [
  'authToken',
  'bucket',
  'clientName',
  'database',
  'dialTimeoutMs',
  'hosts',
  'int64',
  'logger',
  'password',
  'pool',
  'requestTimeoutMs',
  'tls',
  'username',
  'writeConcern',
];
const TLS_KEYS = ['fingerprints', 'insecure', 'knownServersPath', 'onUnknownServer'];
const POOL_KEYS = ['bulkSize', 'idleTimeoutMs', 'maxWaiters', 'size'];

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_POOL: PoolConfig = {
  size: 4,
  bulkSize: 2,
  maxWaiters: 1_000,
  idleTimeoutMs: 120_000,
  pingIntervalMs: 60_000,
  heartbeatMs: 5_000,
};

/** Refuses any key the caller passed that the named object does not accept. */
function refuseUnknownKeys(given: object | undefined, accepted: readonly string[], where: string): void {
  if (given === undefined) return;
  for (const key of Object.keys(given)) {
    if (!accepted.includes(key)) {
      throw new ConfigError('INVALID_OPTIONS', {
        message: `Unknown option "${key}" in ${where}; the accepted options are ${accepted.join(', ')}.`,
        operation: 'connect',
      });
    }
  }
}

/** The hosts an option names, each as a URI host would be written. */
function hostsFromOption(hosts: NonNullable<ConnectOptions['hosts']>): DialTarget[] {
  return hosts.map((entry, hostIndex) => {
    if (typeof entry === 'string') {
      const [first] = parseUri(`hoarddb://${entry}`).hosts;
      if (first === undefined) throw new Error(`no host in "${entry}"`);
      return { host: first.host, port: first.port, hostIndex };
    }
    return { host: entry.host, port: entry.port ?? DEFAULT_PORT, hostIndex };
  });
}

/**
 * The client's options from the three places a caller can put them. The URI is the one given, else
 * HOARDDB_URI when no hosts were passed, else the local default. An option wins over the URI, and the
 * URI over the environment; the environment supplies a user and a password only when the URI does not.
 */
export function resolveOptions(
  uri: string | undefined,
  options: ConnectOptions | undefined,
  env: NodeJS.ProcessEnv,
): ResolvedOptions {
  refuseUnknownKeys(options, CONNECT_KEYS, 'ConnectOptions');
  refuseUnknownKeys(options?.tls, TLS_KEYS, 'tls');
  refuseUnknownKeys(options?.pool, POOL_KEYS, 'pool');

  const insecure = options?.tls?.insecure;
  if (insecure !== undefined && (typeof insecure.reason !== 'string' || insecure.reason.trim() === '')) {
    throw new ConfigError('INVALID_OPTIONS', {
      message:
        "tls.insecure needs a reason, for example { insecure: { reason: 'local test server' } }; it is logged on every connection.",
      operation: 'connect',
    });
  }

  const fromUri = uri ?? (options?.hosts === undefined ? env['HOARDDB_URI'] : undefined) ?? 'hoarddb://localhost';
  const parsed = parseUri(fromUri);

  const hosts = options?.hosts !== undefined ? hostsFromOption(options.hosts) : parsed.hosts.map((host, hostIndex) => ({ ...host, hostIndex }));
  const hasToken = (options?.authToken ?? parsed.params.authToken ?? '') !== '';

  const pool = { ...DEFAULT_POOL };
  if (options?.pool?.size !== undefined) pool.size = options.pool.size;
  if (options?.pool?.bulkSize !== undefined) pool.bulkSize = options.pool.bulkSize;
  if (options?.pool?.maxWaiters !== undefined) pool.maxWaiters = options.pool.maxWaiters;
  if (options?.pool?.idleTimeoutMs !== undefined) pool.idleTimeoutMs = options.pool.idleTimeoutMs;

  return guardSecrets({
    hosts,
    username: options?.username ?? parsed.username ?? env['HOARDDB_ROOT_USER'] ?? 'admin',
    password: options?.password ?? parsed.password ?? (hasToken ? undefined : env['HOARDDB_ROOT_PASSWORD']),
    authToken: options?.authToken ?? parsed.params.authToken ?? undefined,
    database: options?.database ?? parsed.database ?? undefined,
    bucket: options?.bucket ?? parsed.bucket ?? undefined,
    trust: makeTrustPolicy(options?.tls, parsed.params.fingerprints, hosts.length),
    pool,
    dialTimeoutMs: options?.dialTimeoutMs ?? parsed.params.dialTimeoutMs,
    requestTimeoutMs: options?.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
    writeConcern: options?.writeConcern,
    clientName: options?.clientName ?? parsed.params.clientName ?? undefined,
    int64: options?.int64 ?? 'safe',
    logger: options?.logger,
  });
}

/** The resolved options with the two secrets replaced by '***', for JSON and for inspect(). */
function redacted(options: ResolvedOptions): Record<string, unknown> {
  return {
    ...options,
    password: options.password === undefined ? undefined : '***',
    authToken: options.authToken === undefined ? undefined : '***',
  };
}

/**
 * Attaches the redaction to a resolved object without making it an enumerable key, so Object.keys and
 * the spread of the object still show what it holds and only the two printers hide the secrets.
 */
function guardSecrets(options: ResolvedOptions): ResolvedOptions {
  Object.defineProperty(options, 'toJSON', { value: () => redacted(options), enumerable: false });
  Object.defineProperty(options, inspect.custom, { value: () => redacted(options), enumerable: false });
  return options;
}

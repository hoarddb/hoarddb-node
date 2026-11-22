// SPDX-License-Identifier: Apache-2.0
//
// connect(), the only function this module exports (section 3.8). It resolves the options, opens the
// first authenticated connection so a bad password fails here rather than on the first call, and
// starts the pool's heartbeat. Everything else about a client lives in client-core.ts.

import { Session, type AuthResult } from './auth.js';
import { call, countRefusal, type CallContext, type CallStats } from './call.js';
import { createClient } from './client-core.js';
import { resolveOptions } from './options.js';
import { Pool } from './pool.js';
import type { Client, ConnectOptions, ServerInfo } from './types.js';

/** Connects with HOARDDB_URI, else the local default, and the environment's credentials. */
export function connect(): Promise<Client>;
/** Connects to the URI; an option given with it overrides the URI's field of the same name. */
export function connect(uri: string, options?: ConnectOptions): Promise<Client>;
/** Connects with options only: the URI comes from HOARDDB_URI, else the local default. */
export function connect(options: ConnectOptions): Promise<Client>;
export async function connect(first?: string | ConnectOptions, second?: ConnectOptions): Promise<Client> {
  const uri = typeof first === 'string' ? first : undefined;
  const options = typeof first === 'string' ? second : first;
  const resolved = resolveOptions(uri, options, process.env);

  const now = (): number => Date.now();
  const session = new Session(
    { username: resolved.username, password: resolved.password, token: resolved.authToken },
    now,
  );
  let info: ServerInfo = { version: '', protocolVersion: 0, capabilities: new Set<string>() };
  const stats: CallStats = { requests: 0, retries: 0, errors: {} };
  let closed = false;

  const pool = new Pool({
    hosts: resolved.hosts,
    trust: resolved.trust,
    dialTimeoutMs: resolved.dialTimeoutMs,
    session,
    clientName: resolved.clientName,
    config: resolved.pool,
    now,
    random: Math.random,
    logger: resolved.logger,
    onAuth: (result: AuthResult) => {
      info = {
        version: result.serverVersion,
        protocolVersion: result.protocolVersion,
        capabilities: new Set(result.capabilities),
        passwordMinLength: result.passwordMinLength,
      };
    },
  });

  const context: CallContext = {
    pool,
    requestTimeoutMs: resolved.requestTimeoutMs,
    int64: resolved.int64,
    random: Math.random,
    now,
    capabilities: () => info.capabilities,
    serverVersion: () => info.version,
    stats,
    closed: () => closed,
  };

  const client = createClient({
    call: (spec) => call(context, spec),
    options: resolved,
    serverInfo: () => info,
    poolStats: () => ({
      ...pool.stats(),
      requests: stats.requests,
      retries: stats.retries,
      errors: { ...stats.errors },
    }),
    countRefusal: (error: unknown) => countRefusal(stats, error),
    close: async (timeoutMs: number) => {
      closed = true;
      await pool.close(timeoutMs);
    },
    pool,
  });

  try {
    await pool.openFirst(now() + resolved.dialTimeoutMs * resolved.hosts.length);
  } catch (error) {
    closed = true;
    await pool.close(0);
    throw error;
  }
  pool.start();
  return client;
}

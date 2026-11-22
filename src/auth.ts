// SPDX-License-Identifier: Apache-2.0
//
// AUTH and the token session (handbook auth.md sections 1 to 3). Two rules break silently when they
// are broken here, so they are in this file rather than in the pool: the server claims a connection's
// one password attempt before it checks the password, so a refusal spends the socket; and after the
// first password AUTH it is the token, not the password, that a new connection presents.

import { inspect } from 'node:util';

import { ConfigError, errorFromAuthFail, errorFromErrorPayload } from './errors.js';
import { DRIVER_VERSION } from './version.js';
import { PROTOCOL_VERSION, requestIdHex } from './wire/frame.js';
import { decodeResponse, encodeRequest } from './wire/messages.js';
import { Op } from './wire/opcodes.js';
import type { Connection } from './connection.js';

/** What the driver will present: a password, a token, or both on the first frame. */
export interface AuthRequest {
  username: string;
  password?: string;
  token?: string;
  clientName?: string;
}

/** AUTH_OK decoded: what the client needs to keep and what a caller reads. */
export interface AuthResult {
  serverVersion: string;
  protocolVersion: number;
  capabilities: string[];
  token?: string;
  tokenExpiresAt?: number;
  tokenDeadline?: number;
  passwordMinLength?: number;
}

/** Without this capability a token is not exchanged at all (auth.md section 3.5). */
const TOKEN_CAPABILITY = 'auth_token';

export function clientString(clientName?: string): string {
  const base = `hoarddb-node/${DRIVER_VERSION}`;
  return clientName === undefined || clientName === '' ? base : `${base} (${clientName})`;
}

/** An int64 reaches JavaScript as a number or a bigint (D-24); a lifetime is a number either way. */
function seconds(value: unknown): number | undefined {
  if (typeof value === 'number') return value;
  return typeof value === 'bigint' ? Number(value) : undefined;
}

function authResultFrom(fields: Record<string, unknown>): AuthResult {
  const raw = fields['capabilities'];
  const result: AuthResult = {
    serverVersion: typeof fields['server_version'] === 'string' ? fields['server_version'] : '',
    protocolVersion: seconds(fields['protocol_version']) ?? 0,
    capabilities: Array.isArray(raw) ? raw.filter((entry): entry is string => typeof entry === 'string') : [],
  };

  if (typeof fields['token'] === 'string') result.token = fields['token'];
  const expiresAt = seconds(fields['token_expires_at']);
  if (expiresAt !== undefined) result.tokenExpiresAt = expiresAt;
  const deadline = seconds(fields['token_deadline']);
  if (deadline !== undefined) result.tokenDeadline = deadline;
  const minLength = seconds(fields['password_min_length']);
  if (minLength !== undefined) result.passwordMinLength = minLength;

  return result;
}

/**
 * The first frame of a connection. A token is presented with an empty password rather than beside
 * one, so a token never costs a password check, and a refusal destroys the connection: the server
 * has already claimed it.
 */
export async function authenticate(
  conn: Connection,
  request: AuthRequest,
  timeoutMs: number,
): Promise<AuthResult> {
  const token = request.token;
  const payload = encodeRequest('AUTH', {
    username: request.username,
    password: token === undefined || token === '' ? request.password : '',
    protocol_version: BigInt(PROTOCOL_VERSION),
    capabilities: [],
    client: clientString(request.clientName),
    ...(token === undefined || token === '' ? {} : { token }),
  });

  const frame = await conn.send(Op.AUTH, payload, { timeoutMs, expect: [Op.AUTH_OK, Op.AUTH_FAIL] });
  if (frame.opcode === Op.ERROR) {
    // An ERROR is never a login (handbook errors.md section 1). The server sends one when its auth
    // handler fails (INTERNAL, the request's own ID) and when its connection budget is full
    // (OVERLOADED, ID zero); either way this socket never authenticated, so it is not handed out.
    try {
      throw errorFromErrorPayload(frame.payload, {
        operation: 'auth',
        target: conn.address,
        requestId: requestIdHex(frame.requestId),
      });
    } finally {
      conn.destroy();
    }
  }
  if (frame.opcode === Op.AUTH_FAIL) {
    const failure = errorFromAuthFail(frame.payload, {
      operation: 'auth',
      target: conn.address,
      user: request.username,
    });
    conn.destroy();
    throw failure;
  }
  return authResultFrom(decodeResponse('AUTH', frame.payload, 'safe'));
}

/**
 * The credentials one client holds: the password for as long as it may need it, and the token that
 * replaces it on every connection after the first. The refresh clock lives here so that one refresh
 * decision is made once per client rather than once per connection.
 */
export class Session {
  /** The pool sets this while a refresh is in flight, so a pool of connections does not stampede. */
  refreshing = false;
  /** Successful password AUTHs and token AUTHs, counted for poolStats(). */
  passwordAuths = 0;
  tokenAuths = 0;

  readonly username: string;

  // The secrets are ES private fields, which inspect, a console log and JSON.stringify never read; the
  // session also says so itself (toJSON, inspect.custom), in case a copy of it is ever printed.
  readonly #password: string | undefined;
  #token: string | undefined;
  private expiresAt: number | undefined;
  private deadline: number | undefined;
  private issuedAt = 0;

  constructor(
    credentials: { username: string; password?: string; token?: string },
    private readonly now: () => number,
  ) {
    this.username = credentials.username;
    this.#password = credentials.password;
    // A token the program supplied is used for the first connection and refreshed like any other.
    this.#token = credentials.token;
  }

  /** What a new connection presents: the token when there is one, else the password. */
  credentialForNewConnection(): { token: string } | { password: string } {
    if (this.#token !== undefined && this.#token !== '') return { token: this.#token };
    if (this.#password !== undefined && this.#password !== '') return { password: this.#password };

    throw new ConfigError('INVALID_OPTIONS', {
      message: `No password for user "${this.username}": put it in the URI (hoarddb://${this.username}:<password>@host), pass { password }, or set HOARDDB_ROOT_PASSWORD.`,
      operation: 'connect',
    });
  }

  /** Keep what the answer carried. A server without auth_token is not trusted with a token at all. */
  record(result: AuthResult): void {
    this.issuedAt = this.now();
    if (!result.capabilities.includes(TOKEN_CAPABILITY)) {
      this.dropToken();
      return;
    }
    this.#token = result.token;
    this.expiresAt = result.tokenExpiresAt;
    this.deadline = result.tokenDeadline;
  }

  /** Forget the token: the password is used again, once. */
  dropToken(): void {
    this.#token = undefined;
    this.expiresAt = undefined;
    this.deadline = undefined;
  }

  /** Half the token's own lifetime has passed, which is when the refresh chain must be walked. */
  needsRefresh(): boolean {
    if (this.#token === undefined || this.#token === '' || this.refreshing || this.expiresAt === undefined) {
      return false;
    }
    const lifetimeEnd = this.expiresAt * 1000;
    return this.now() >= this.issuedAt + (lifetimeEnd - this.issuedAt) / 2;
  }

  /** What a log may see: the user, and whether a password and a token are held, never their values. */
  toJSON(): { username: string; password: string | undefined; token: string | undefined } {
    return {
      username: this.username,
      password: this.#password === undefined ? undefined : '***',
      token: this.#token === undefined ? undefined : '***',
    };
  }

  [inspect.custom](): string {
    return `Session ${inspect(this.toJSON())}`;
  }

  /** The refresh chain is over: the token can no longer be renewed and the password is needed. */
  pastDeadline(): boolean {
    return this.deadline !== undefined && this.now() >= this.deadline * 1000;
  }
}
// SPDX-License-Identifier: Apache-2.0
//
// The pool (build doc step 9; handbook wire.md sections 7 to 9, auth.md section 3). A connection
// holds one request at a time, so what the pool hands out is a slot, not a socket: pipelining
// later is a capacity change and nothing else has to move. Two lanes (a point lane and a bulk lane)
// are dialled lazily, because a client that touches one bucket must not open six sockets to do it.
//
// Four orders in here fail silently when they break, so they are in this file rather than in the
// caller: a host that is down falls through to the next one while a key the client will not accept
// stops the dial at once; a refused dial backs its lane off instead of failing a caller; a waiter
// queue is bounded and served in order; and closing is destroy() and never end(), because a
// half-close reads to the server as a client that has gone.

import { authenticate, type AuthResult, type Session } from './auth.js';
import { Connection, type DialTarget } from './connection.js';
import {
  AbortedError,
  AuthenticationError,
  ClientClosedError,
  ConfigError,
  ConnectionError,
  PoolTimeoutError,
  isHoardDBError,
  type HoardDBError,
} from './errors.js';
import type { TrustPolicy } from './trust.js';
import { Op } from './wire/opcodes.js';

/** Which queue a call waits in: one request in flight per connection, so the lanes are the pools. */
export type Lane = 'point' | 'bulk';

/** Every number the pool decides on. The client builds it from the caller's options and D-25. */
export interface PoolConfig {
  size: number;
  bulkSize: number;
  maxWaiters: number;
  idleTimeoutMs: number;
  pingIntervalMs: number;
  heartbeatMs: number;
}

/** The program's own logger (section 3.1). The pool never writes to stdout itself. */
export interface Logger {
  debug(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
}

export interface PoolDeps {
  hosts: DialTarget[];
  trust: TrustPolicy;
  dialTimeoutMs: number;
  session: Session;
  clientName?: string;
  config: PoolConfig;
  now: () => number;
  random: () => number;
  logger?: Logger;
  /** The client records serverInfo from the first AUTH_OK. */
  onAuth: (result: AuthResult) => void;
}

export interface Lease {
  readonly connection: Connection;
  /** The slot is free again; the next waiter in the lane gets it. */
  release(): void;
  /** The socket is finished: it is destroyed and the lane redials for the next waiter. */
  discard(): void;
}

/** One lane's shape for poolStats(); step 11 declares the same shape in the public surface. */
export interface LaneStats {
  open: number;
  inUse: number;
  waiting: number;
}

/** A ping that never answers must not hold a lease for the request timeout of a real call. */
const PING_TIMEOUT_MS = 10_000;
/** Full jitter on the wait before a refused token is replaced by the password (auth.md section 3). */
const TOKEN_FALLBACK_JITTER_MS = 250;
/** Dial backoff: 100 ms doubling to 5 s, each attempt multiplied by the caller's random(). */
const DIAL_BACKOFF_CEILING_MS = 5_000;
const DIAL_BACKOFF_BASE_MS = 100;
/** How often close() looks for a lease that was never given back. */
const CLOSE_POLL_MS = 5;

/** An open connection and whether a caller holds its one slot. */
interface Pooled {
  readonly connection: Connection;
  readonly lane: LaneState;
  leased: boolean;
  lastPingedAt: number;
}

/** A caller waiting for a slot. Its own deadline and abort are armed while it is queued. */
interface Waiter {
  readonly budgetMs: number;
  /** The caller's own deadline, which a dial made on this waiter's behalf is bounded by. */
  readonly deadline: number;
  readonly resolve: (lease: Lease) => void;
  readonly reject: (error: HoardDBError) => void;
  timer: NodeJS.Timeout;
  signal?: AbortSignal;
  onAbort?: () => void;
  settled: boolean;
}

interface LaneState {
  readonly name: Lane;
  /** The size the caller asked for; the ceiling drops below it and comes back to it. */
  readonly configured: number;
  ceiling: number;
  readonly open: Set<Pooled>;
  readonly waiters: Waiter[];
  /** Dials in flight, counted against the ceiling so N callers open N sockets and not N more. */
  dialing: number;
  /** Failed dials in a row, which is what the backoff doubles on. */
  failures: number;
}

type DialOutcome = { kind: 'open'; pooled: Pooled } | { kind: 'refused'; refusal: HoardDBError };

type HostOutcome = { kind: 'ok'; pooled: Pooled } | { kind: 'next'; error: HoardDBError } | { kind: 'refused'; refusal: HoardDBError };

type LoginOutcome =
  | { kind: 'ok'; result: AuthResult }
  | { kind: 'refused'; refusal: HoardDBError }
  | { kind: 'next'; error: HoardDBError }
  | { kind: 'token-refused'; error: AuthenticationError };

const sleep = (ms: number): Promise<void> => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));

/** A backoff the caller can cut short; the caller checks the signal afterwards. */
function sleepUnlessAborted(ms: number, signal: AbortSignal | undefined): Promise<void> {
  if (signal === undefined) return sleep(ms);
  return new Promise((resolveSleep) => {
    const done = (): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolveSleep();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
  });
}

function addressOf(target: DialTarget): string {
  return `${target.host}:${target.port}`;
}

function idleOf(state: LaneState): Pooled | undefined {
  for (const pooled of state.open) {
    if (!pooled.leased) return pooled;
  }
  return undefined;
}

function leasedOf(state: LaneState): number {
  let leased = 0;
  for (const pooled of state.open) {
    if (pooled.leased) leased += 1;
  }
  return leased;
}

function laneStatsOf(state: LaneState): LaneStats {
  return { open: state.open.size, inUse: leasedOf(state), waiting: state.waiters.length };
}

function closedError(): ClientClosedError {
  return new ClientClosedError({
    message: 'This client was closed. Create a new one with connect().',
    operation: 'acquire',
  });
}

function queueFullError(lane: Lane, maxWaiters: number): PoolTimeoutError {
  return new PoolTimeoutError({
    message: `${maxWaiters} calls are already waiting for a connection on the ${lane} lane; refusing this one instead of queueing without bound.`,
    operation: 'acquire',
  });
}

function queueTimeoutError(state: LaneState, budgetMs: number): PoolTimeoutError {
  return new PoolTimeoutError({
    message: `No connection became free within ${budgetMs} ms (${leasedOf(state)} in use, ${state.waiters.length} waiting on the ${state.name} lane). Raise pool.size or pool.bulkSize, or find the call that holds a connection.`,
    operation: 'acquire',
  });
}

function abortError(signal: AbortSignal | undefined): AbortedError {
  return new AbortedError({
    message: 'waiting for a connection on this client was aborted.',
    operation: 'acquire',
    cause: signal?.reason,
  });
}

/**
 * A login that was answered and a socket that closed at once: nothing can be sent on it, so the next
 * host is tried. A server that refuses with a sentence (OVERLOADED) is not this: that sentence
 * reaches the caller through authenticate() whichever order the refusal and AUTH crossed in.
 */
function closedAfterLogin(connection: Connection): ConnectionError {
  return new ConnectionError({
    message: `The connection to ${connection.address} closed as soon as it had logged in.`,
    operation: 'connect',
    target: connection.address,
  });
}

/** Every host failed to answer, so the message names them all rather than only the last one. */
function allHostsFailed(last: HoardDBError, tried: readonly string[]): ConnectionError {
  const list = tried.join(', ');
  const loopback = 'The server listens on 127.0.0.1:7433 by default; the container image listens on every interface. ';
  // Connection.dial puts the errno in parentheses; a message without one is quoted whole.
  const detail = / \(([^()]*)\)\. /.exec(last.message);
  const where = last.target ?? 'the host';

  return new ConnectionError({
    message: `Could not connect to ${where} (${detail?.[1] ?? last.message}). Is hoardDB-server running there? ${loopback}Tried ${tried.length} host(s): ${list}.`,
    operation: 'connect',
    target: where,
  });
}

/** Why a socket was given up, for destroy(): the driver's own error, or what the socket said. */
function reasonOf(error: unknown): HoardDBError {
  if (isHoardDBError(error)) return error;
  return new ConnectionError({
    message: `The connection failed (${(error as Error).message}).`,
    operation: 'connect',
    cause: error,
  });
}

export class Pool {
  /** The credentials the pool presents, and the token it refreshes: one per client, not per socket. */
  readonly session: Session;
  /** Connections dialled so far, failures included; poolStats() reports what the client spent. */
  dialCount = 0;

  private readonly lanes: Readonly<Record<Lane, LaneState>>;
  private isClosed = false;
  private timer: NodeJS.Timeout | undefined;

  constructor(private readonly deps: PoolDeps) {
    this.session = deps.session;
    const lane = (name: Lane, size: number): LaneState => ({
      name,
      configured: size,
      ceiling: size,
      open: new Set<Pooled>(),
      waiters: [],
      dialing: 0,
      failures: 0,
    });
    this.lanes = { point: lane('point', deps.config.size), bulk: lane('bulk', deps.config.bulkSize) };
  }

  /**
   * One slot of one lane. A free slot is taken, else a socket is dialled while the lane is under its
   * ceiling, else the caller queues; a server that refuses the dial makes the lane wait for a slot
   * rather than fail a caller that has nowhere else to go.
   */
  async acquire(lane: Lane, deadline: number, signal?: AbortSignal): Promise<Lease> {
    const state = this.lanes[lane];
    if (this.isClosed) throw closedError();
    if (signal?.aborted === true) throw abortError(signal);

    const free = idleOf(state);
    if (free !== undefined) return this.lease(free);

    if (state.open.size + state.dialing < state.ceiling) {
      const outcome = await this.reserve(state, deadline, signal);
      if (outcome.kind === 'open') return this.lease(outcome.pooled);
      if (state.open.size === 0) throw outcome.refusal;

      state.ceiling = state.open.size;
      this.deps.logger?.debug('a dial was refused; the lane waits for a slot instead of dialling again', {
        lane,
        open: state.open.size,
        refusal: outcome.refusal.message,
      });
    }

    return this.queue(state, deadline, signal);
  }

  /** connect(): one authenticated point connection now, so the first call finds a warm socket. */
  async openFirst(deadline: number): Promise<void> {
    if (this.isClosed) throw closedError();

    const outcome = await this.reserve(this.lanes.point, deadline);
    if (outcome.kind === 'open' || this.lanes.point.open.size > 0) return;
    throw outcome.refusal;
  }

  /**
   * A dial with its place in the lane's ceiling taken before the first await (so N callers open N
   * sockets and not N more) and the lane's backoff waited out. A dial that fails counts towards the
   * backoff of the next one; a dial that succeeds clears it.
   */
  private async reserve(state: LaneState, deadline: number, signal?: AbortSignal): Promise<DialOutcome> {
    state.dialing += 1;
    let outcome: DialOutcome;
    try {
      await this.backoff(state, deadline, signal);
      outcome = await this.open(state, deadline, signal);
    } catch (error) {
      // A dial that failed outright (no host answered, a key refused) is a failed dial too: the
      // next one in this lane waits, or a dead host is hammered as fast as callers arrive. A caller
      // that gave up or a client that closed says nothing about the server.
      if (!(error instanceof AbortedError) && !(error instanceof ClientClosedError)) state.failures += 1;
      throw error;
    } finally {
      state.dialing -= 1;
    }
    state.failures = outcome.kind === 'open' ? 0 : state.failures + 1;
    return outcome;
  }

  /** The heartbeat: idle sockets are pinged and closed, and one token is refreshed for the client. */
  async tick(): Promise<void> {
    await this.tendConnections();
    if (this.session.pastDeadline()) this.session.dropToken();
    if (this.session.needsRefresh()) await this.refreshToken();
  }

  /** One unref()ed timer for the client: an unclosed client must not hold the process alive. */
  start(): void {
    if (this.timer !== undefined) return;
    const timer = setInterval(() => {
      this.tick().catch((error: unknown) => {
        this.deps.logger?.warn('the pool heartbeat failed', { error: String(error) });
      });
    }, this.deps.config.heartbeatMs);
    timer.unref();
    this.timer = timer;
  }

  stats(): { point: LaneStats; bulk: LaneStats } {
    return { point: laneStatsOf(this.lanes.point), bulk: laneStatsOf(this.lanes.bulk) };
  }

  /** Refuse new acquires, wait for the leases that are out, then destroy every socket. */
  async close(timeoutMs: number): Promise<void> {
    this.isClosed = true;
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    for (const state of this.allLanes()) {
      for (const waiter of state.waiters.splice(0)) this.rejectWaiter(waiter, closedError());
    }

    const deadline = this.deps.now() + timeoutMs;
    while (this.leasesHeld() > 0 && this.deps.now() < deadline) await sleep(CLOSE_POLL_MS);

    for (const state of this.allLanes()) {
      for (const pooled of [...state.open]) pooled.connection.destroy();
      state.open.clear();
      state.ceiling = state.configured;
    }
  }

  private allLanes(): LaneState[] {
    return [this.lanes.point, this.lanes.bulk];
  }

  private leasesHeld(): number {
    return leasedOf(this.lanes.point) + leasedOf(this.lanes.bulk);
  }

  /** Full jitter on the backoff after a failed dial, never longer than the caller's own deadline. */
  private async backoff(state: LaneState, deadline: number, signal?: AbortSignal): Promise<void> {
    if (state.failures === 0) return;
    const jitter = this.deps.random() * Math.min(DIAL_BACKOFF_CEILING_MS, DIAL_BACKOFF_BASE_MS * 2 ** (state.failures - 1));
    const wait = Math.min(jitter, Math.max(deadline - this.deps.now(), 0));
    if (wait > 0) await sleepUnlessAborted(wait, signal);
    if (signal?.aborted === true) throw abortError(signal);
  }

  /**
   * How long a dial or a login may take: its own budget, never past the caller's deadline. A call
   * with 150 ms left must not wait out a 10 s handshake and then be written late.
   */
  private budget(deadline: number): number {
    return Math.max(1, Math.min(this.deps.dialTimeoutMs, deadline - this.deps.now()));
  }

  private async connect(target: DialTarget, deadline: number, signal?: AbortSignal): Promise<Connection> {
    this.dialCount += 1;
    return Connection.dial({
      target,
      trust: this.deps.trust,
      dialTimeoutMs: this.budget(deadline),
      now: this.deps.now,
      ...(signal === undefined ? {} : { signal }),
    });
  }

  /** Hosts in written order; the first refusal that names the program stops the dial at once. */
  private async open(state: LaneState, deadline: number, signal?: AbortSignal): Promise<DialOutcome> {
    const tried: string[] = [];
    let last: HoardDBError | undefined;
    let refusal: HoardDBError | undefined;

    for (const target of this.deps.hosts) {
      let outcome: HostOutcome;
      try {
        outcome = await this.attemptHost(state, target, deadline, signal);
      } catch (error) {
        // A refusal that names the program (a key this client will not accept, a password it must
        // not keep guessing, a credential it does not have) is thrown out of here: the next host
        // would refuse it the same way. A host that simply did not answer gets the next one.
        if (!(error instanceof ConnectionError)) throw error;
        tried.push(addressOf(target));
        last = error;
        refusal = undefined;
        continue;
      }
      if (outcome.kind === 'ok') return { kind: 'open', pooled: outcome.pooled };
      tried.push(addressOf(target));
      if (outcome.kind === 'next') {
        last = outcome.error;
        refusal = undefined;
      } else {
        refusal = outcome.refusal;
      }
    }

    // Every host failed. A refusal from the server is not a connection failure and keeps its own
    // sentence; a connection failure says every host that was tried.
    if (refusal !== undefined) return { kind: 'refused', refusal };
    if (last === undefined) {
      throw new ConfigError('INVALID_OPTIONS', {
        message: 'No host was given: pass a URI or { hosts }. The client has nothing to dial.',
        operation: 'connect',
      });
    }
    if (last instanceof ConnectionError) throw allHostsFailed(last, tried);
    throw last;
  }

  /** One host: a socket, a login, and the password once more when the token was refused. */
  private async attemptHost(
    state: LaneState,
    target: DialTarget,
    deadline: number,
    signal?: AbortSignal,
  ): Promise<HostOutcome> {
    let connection = this.unlessClosed(await this.connect(target, deadline, signal));
    let outcome = await this.login(connection, deadline, signal);

    if (outcome.kind === 'token-refused') {
      // The token is spent: the password is presented once, on a new socket, and whatever that
      // says is what the caller sees (auth.md section 3).
      const refusedToken = outcome;
      this.session.dropToken();
      await sleep(this.deps.random() * TOKEN_FALLBACK_JITTER_MS);
      connection = this.unlessClosed(await this.connect(target, deadline, signal));
      try {
        outcome = await this.login(connection, deadline, signal);
      } catch (error) {
        if (!(error instanceof AuthenticationError)) throw error;
        // The password was refused too, so the caller hears the token's sentence: that is the one
        // that says the driver fell back to the password. What the password got is kept as its
        // cause rather than thrown away.
        throw new AuthenticationError({
          message: refusedToken.error.message,
          operation: refusedToken.error.operation,
          target: refusedToken.error.target,
          reason: refusedToken.error.reason,
          retryable: refusedToken.error.retryable,
          cause: error,
        });
      }
    }

    if (outcome.kind === 'ok') return { kind: 'ok', pooled: this.track(state, this.unlessClosed(connection)) };
    if (outcome.kind === 'next') return { kind: 'next', error: outcome.error };
    return { kind: 'refused', refusal: outcome.kind === 'token-refused' ? outcome.error : outcome.refusal };
  }

  /** Reasons that name the program stop here; a server that cannot check a login gets the next host. */
  private async login(connection: Connection, deadline: number, signal?: AbortSignal): Promise<LoginOutcome> {
    const credential = this.session.credentialForNewConnection();
    const request = {
      username: this.session.username,
      ...credential,
      ...(this.deps.clientName === undefined ? {} : { clientName: this.deps.clientName }),
    };
    // A caller that gives up during the login takes the half-dialled socket with it.
    const onAbort = (): void => connection.destroy(abortError(signal));
    signal?.addEventListener('abort', onAbort, { once: true });

    try {
      const result = await authenticate(connection, request, this.budget(deadline));
      if (connection.closed) return { kind: 'next', error: closedAfterLogin(connection) };

      this.session.record(result);
      if ('token' in credential) this.session.tokenAuths += 1;
      else this.session.passwordAuths += 1;
      this.deps.onAuth(result);
      return { kind: 'ok', result };
    } catch (error) {
      const failure = reasonOf(error);
      // An abort stops the dial: the next host would be dialled for a caller who has gone.
      if (failure instanceof AbortedError) throw failure;
      if (!(failure instanceof AuthenticationError)) return { kind: 'refused', refusal: failure };

      switch (failure.reason) {
        case 'INTERNAL':
          return { kind: 'next', error: failure };
        case 'TOKEN_EXPIRED':
        case 'TOKEN_INVALID':
        case 'TOKEN_UNSUPPORTED':
          return { kind: 'token-refused', error: failure };
        default:
          // CREDENTIALS, RATE_LIMITED, PROTOCOL_MISMATCH and ALREADY_AUTHED: a refusal the driver
          // does not repeat, because the server has counted it against this address.
          throw failure;
      }
    } finally {
      signal?.removeEventListener('abort', onAbort);
    }
  }

  /**
   * A dial that finishes after close() must not hand out a live socket nobody will ever destroy: it
   * is destroyed here and the caller hears that the client is closed.
   */
  private unlessClosed(connection: Connection): Connection {
    if (!this.isClosed) return connection;
    connection.destroy(closedError());
    throw closedError();
  }

  /** An authenticated socket joins its lane, and leaves it the moment the socket is gone. */
  private track(state: LaneState, connection: Connection): Pooled {
    const pooled: Pooled = { connection, lane: state, leased: false, lastPingedAt: connection.lastUsedAt };
    state.open.add(pooled);
    connection.onClose(() => {
      if (!state.open.delete(pooled)) return;
      // A closed connection is the only news that says the server's cap may have room again.
      state.ceiling = state.configured;
      this.drain(state);
    });
    return pooled;
  }

  private lease(pooled: Pooled): Lease {
    pooled.leased = true;
    let released = false;

    return {
      connection: pooled.connection,
      release: (): void => {
        if (released) return;
        released = true;
        pooled.leased = false;
        this.handBack(pooled);
      },
      discard: (): void => {
        if (released) return;
        released = true;
        pooled.leased = false;
        pooled.connection.destroy();
      },
    };
  }

  /** A slot is free: the first waiter takes it, and any waiter left takes a fresh socket. */
  private handBack(pooled: Pooled): void {
    const state = pooled.lane;
    // A waiter is only taken off the queue for a slot it can have.
    if (!pooled.connection.closed) {
      const waiter = state.waiters.shift();
      if (waiter !== undefined) this.settle(waiter, pooled);
    }
    this.drain(state);
  }

  /** Serve every waiter a free slot fits, then dial for the head of what is left. */
  private drain(state: LaneState): void {
    if (this.isClosed) return;
    for (let idle = idleOf(state); idle !== undefined && state.waiters.length > 0; idle = idleOf(state)) {
      const waiter = state.waiters.shift();
      if (waiter !== undefined) this.settle(waiter, idle);
    }
    if (state.waiters.length === 0 || state.open.size + state.dialing >= state.ceiling) return;

    const waiter = state.waiters[0];
    if (waiter === undefined) return;
    void this.reserve(state, waiter.deadline).then((outcome) => {
      const head = state.waiters[0];

      if (outcome.kind === 'open') {
        // The head waiter was served while this dial was in flight: the socket is spare.
        if (head !== waiter) outcome.pooled.connection.destroy();
        else {
          state.waiters.shift();
          this.settle(waiter, outcome.pooled);
        }
      } else if (head === waiter) {
        if (state.open.size === 0) {
          state.waiters.shift();
          this.rejectWaiter(waiter, outcome.refusal);
        } else {
          state.ceiling = state.open.size;
        }
      }
      this.drain(state);
    }, (error: unknown) => {
      // A dial made for a waiter that stops the dial outright (a key this client will not accept, a
      // refused password, a closed client) is that waiter's answer, never an unhandled rejection.
      if (state.waiters[0] === waiter) {
        state.waiters.shift();
        this.rejectWaiter(waiter, reasonOf(error));
      }
      this.drain(state);
    });
  }

  /** The shared path for a caller that could not have a slot: it waits, bounded, in order. */
  private queue(state: LaneState, deadline: number, signal?: AbortSignal): Promise<Lease> {
    if (state.waiters.length >= this.deps.config.maxWaiters) {
      return Promise.reject(queueFullError(state.name, this.deps.config.maxWaiters));
    }

    const budgetMs = Math.max(0, deadline - this.deps.now());
    return new Promise<Lease>((resolveLease, rejectLease) => {
      const waiter: Waiter = {
        budgetMs,
        deadline,
        settled: false,
        resolve: resolveLease,
        reject: rejectLease,
        timer: setTimeout(() => this.giveUp(state, waiter, queueTimeoutError(state, budgetMs)), budgetMs),
      };
      state.waiters.push(waiter);

      if (signal !== undefined) {
        waiter.signal = signal;
        waiter.onAbort = (): void => this.giveUp(state, waiter, abortError(signal));
        signal.addEventListener('abort', waiter.onAbort, { once: true });
      }
      this.drain(state);
    });
  }

  private settle(waiter: Waiter, pooled: Pooled): void {
    // A waiter that gave up in the same tick leaves the slot free for whoever is next.
    if (waiter.settled) return;
    waiter.settled = true;
    clearTimeout(waiter.timer);
    this.offAbort(waiter);
    waiter.resolve(this.lease(pooled));
  }

  /** A waiter that timed out, was aborted or was refused leaves the queue at once. */
  private giveUp(state: LaneState, waiter: Waiter, error: HoardDBError): void {
    if (waiter.settled) return;
    const at = state.waiters.indexOf(waiter);
    if (at >= 0) state.waiters.splice(at, 1);
    this.rejectWaiter(waiter, error);
    this.drain(state);
  }

  private rejectWaiter(waiter: Waiter, error: HoardDBError): void {
    if (waiter.settled) return;
    waiter.settled = true;
    clearTimeout(waiter.timer);
    this.offAbort(waiter);
    waiter.reject(error);
  }

  private offAbort(waiter: Waiter): void {
    if (waiter.onAbort === undefined) return;
    waiter.signal?.removeEventListener('abort', waiter.onAbort);
    waiter.onAbort = undefined;
  }

  /** Idle sockets are pinged so the server does not close them, and closed once they are stale. */
  private async tendConnections(): Promise<void> {
    for (const state of this.allLanes()) {
      for (const pooled of [...state.open]) {
        if (pooled.leased || pooled.connection.closed) continue;

        const idleFor = this.deps.now() - pooled.connection.lastUsedAt;
        if (idleFor >= this.deps.config.idleTimeoutMs) {
          pooled.connection.destroy();
          continue;
        }
        if (idleFor < this.deps.config.pingIntervalMs) continue;
        if (this.deps.now() - pooled.lastPingedAt < this.deps.config.pingIntervalMs) continue;

        pooled.lastPingedAt = this.deps.now();
        const lease = this.lease(pooled);
        try {
          await pooled.connection.send(Op.PING, new Uint8Array(0), { timeoutMs: PING_TIMEOUT_MS, expect: [Op.PONG] });
        } catch (error) {
          pooled.connection.destroy(reasonOf(error));
        } finally {
          lease.release();
        }
      }
    }
  }

  /** One token AUTH for the whole client, on one idle point socket, however many are due. */
  private async refreshToken(): Promise<void> {
    const pooled = idleOf(this.lanes.point);
    if (pooled === undefined) return;

    const credential = this.session.credentialForNewConnection();
    if (!('token' in credential)) return;

    this.session.refreshing = true;
    const lease = this.lease(pooled);
    try {
      const result = await authenticate(
        pooled.connection,
        { username: this.session.username, token: credential.token },
        this.deps.dialTimeoutMs,
      );
      this.session.record(result);
      this.session.tokenAuths += 1;
      this.deps.onAuth(result);
    } catch (error) {
      // A refresh that fails spends the socket it was on and the token with it: the next dial
      // presents the password, which is what pastDeadline() would have done anyway.
      pooled.connection.destroy(reasonOf(error));
      this.session.dropToken();
      this.deps.logger?.debug('the token could not be refreshed; the next dial uses the password', {
        error: String(error),
      });
    } finally {
      lease.release();
      this.session.refreshing = false;
    }
  }
}

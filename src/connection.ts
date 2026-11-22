// SPDX-License-Identifier: Apache-2.0
//
// One socket to one host (handbook wire.md sections 1 and 2). Two orders are enforced here because
// breaking either fails silently: the key is decided before the first byte is written, so an
// untrusted server never sees a password, and every answer is matched to the request ID it was sent
// with, so a late or invented answer cannot be read as somebody else's.
//
// end() is never called: a half-close reads to the server as a client that has gone, so closing is
// always destroy().

import { isIP } from 'node:net';
import { connect as connectTls, type TLSSocket } from 'node:tls';

import {
  AbortedError,
  ConnectionError,
  HoardDBError,
  InternalError,
  ProtocolError,
  RequestTimeoutError,
  errorFromErrorPayload,
  isHoardDBError,
} from './errors.js';
import { decideTrust, publicKeyOfCertificate, type TrustPolicy } from './trust.js';
import {
  FrameDecoder,
  FrameError,
  encodeFrameHeader,
  isZeroRequestId,
  newRequestId,
  requestIdHex,
  type Frame,
  type FrameRefusal,
} from './wire/frame.js';
import { Op, opName } from './wire/opcodes.js';

/** The only protocol this driver speaks, offered and required in both directions. */
const ALPN = 'hoarddb/1';
/** One request per connection in v1, so an answer needs no stream of its own to be correlated. */
const MAX_IN_FLIGHT = 1;
const KEEP_ALIVE_MS = 60_000;

/** The hosts whose default port the error message can name without being wrong. */
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '::1']);

export interface DialTarget {
  host: string;
  port: number;
  hostIndex: number;
}

export interface ConnectionOptions {
  target: DialTarget;
  trust: TrustPolicy;
  dialTimeoutMs: number;
  signal?: AbortSignal;
  now?: () => number;
}

export interface SendOptions {
  timeoutMs: number;
  signal?: AbortSignal;
  expect: readonly number[];
}

interface Pending {
  opcode: number;
  expect: readonly number[];
  resolve: (frame: Frame) => void;
  reject: (error: HoardDBError) => void;
  /** Clears the timeout and takes the abort listener off, whatever settled this request. */
  settle: () => void;
}

function addressOf(host: string, port: number): string {
  return `${host}:${port}`;
}

/** What a refusal about this socket was doing: the request's own name, in lower case. */
function operationOf(opcode: number): string {
  return opName(opcode).toLowerCase();
}

/** A dial that never got a connection, in the order section 5.2 gives: what, then the fix. */
function connectFailed(address: string, host: string, reason: string): ConnectionError {
  const loopback = LOOPBACK_HOSTS.has(host)
    ? 'The server listens on 127.0.0.1:7433 by default; the container image listens on every interface. '
    : '';
  return new ConnectionError({
    message: `Could not connect to ${address} (${reason}). Is hoardDB-server running there? ${loopback}Tried 1 host(s): ${address}.`,
    operation: 'connect',
    target: address,
  });
}

/** Marks a refusal raised before anything was written; an outcome the server gave is kept. */
function notSent(error: HoardDBError): HoardDBError {
  if (error.writeOutcome === undefined) {
    Object.defineProperty(error, 'writeOutcome', { value: 'not_applied', enumerable: true });
  }
  return error;
}

/** Backpressure: the socket's buffer is full, so the write is finished when it drains or dies. */
function waitForDrain(socket: TLSSocket): Promise<void> {
  return new Promise((resolveDrain) => {
    const done = (): void => {
      socket.off('drain', done);
      socket.off('close', done);
      resolveDrain();
    };
    socket.once('drain', done);
    socket.once('close', done);
  });
}

export class Connection {
  /**
   * A connected, already trusted socket. The handshake, the ALPN check and the trust decision all
   * happen before this resolves, so nothing is written before a key has been accepted.
   */
  static dial(options: ConnectionOptions): Promise<Connection> {
    return new Promise<Connection>((resolveDial, rejectDial) => {
      const { target, trust, dialTimeoutMs, signal, now } = options;
      const address = addressOf(target.host, target.port);
      const abortSignal = signal;

      const aborted = (): AbortedError =>
        new AbortedError({
          message: `connect to ${address} was aborted.`,
          operation: 'connect',
          target: address,
          cause: abortSignal?.reason,
        });

      if (abortSignal?.aborted === true) {
        rejectDial(aborted());
        return;
      }

      // The certificate is judged by the trust policy, never by the verifier: the key is pinned, and
      // a self-signed server is the normal case. Nothing confidential is written before that.
      const socket = connectTls({
        host: target.host,
        port: target.port,
        servername: isIP(target.host) !== 0 ? undefined : target.host,
        ALPNProtocols: [ALPN],
        minVersion: 'TLSv1.3',
        rejectUnauthorized: false,
      });
      const connection = new Connection(socket, target, now ?? Date.now);

      let settled = false;
      const finish = (): void => {
        settled = true;
        clearTimeout(timer);
        abortSignal?.removeEventListener('abort', onAbort);
        socket.off('error', onHandshakeError);
      };
      const fail = (error: HoardDBError): void => {
        if (settled) return;
        finish();
        connection.destroy(error);
        rejectDial(error);
      };
      const onAbort = (): void => fail(aborted());
      abortSignal?.addEventListener('abort', onAbort, { once: true });
      const timer = setTimeout(
        () => fail(connectFailed(address, target.host, `the handshake did not finish in ${dialTimeoutMs} ms`)),
        dialTimeoutMs,
      );

      // A refusal before the handshake is a connect failure, and the error code (ECONNREFUSED) is the part that says
      // which one: refused, unreachable, or a name that resolves nowhere.
      const onHandshakeError = (error: NodeJS.ErrnoException): void => {
        if (!settled) fail(connectFailed(address, target.host, String(error.code ?? error.errno ?? error.message)));
      };
      socket.on('error', onHandshakeError);

      socket.once('secureConnect', () => {
        void (async () => {
          try {
            // The server re-checks this itself (wire.md section 1), so a mismatch means it is not
            // a hoardDB server and the bytes of this socket must not be interpreted at all.
            if (socket.alpnProtocol !== ALPN) {
              throw new ProtocolError({
                message: `The server at ${address} sent ALPN "${String(socket.alpnProtocol)}" instead of ${ALPN}. The connection was discarded.`,
                operation: 'connect',
                target: address,
              });
            }

            const certificate = socket.getPeerCertificate(true);
            const decision = await decideTrust(trust, {
              host: target.host,
              port: target.port,
              hostIndex: target.hostIndex,
              publicKey: publicKeyOfCertificate(certificate.raw),
            });
            // The callback that accepted a new key is a program of its own: a dial that was given up
            // while it ran must not hand back a live socket.
            if (settled) return;
            if (!decision.ok) throw decision.error;

            connection.trusted(decision.fingerprint);
            connection.startReading();
            socket.setNoDelay(true);
            socket.setKeepAlive(true, KEEP_ALIVE_MS);
            finish();
            resolveDial(connection);
          } catch (error) {
            fail(
              isHoardDBError(error)
                ? error
                : new InternalError({
                    message: `The trust check for ${address} failed: ${(error as Error).message}`,
                    operation: 'connect',
                    target: address,
                    cause: error,
                  }),
            );
          }
        })();
      });
    });
  }

  /** How many requests this connection answers at once: one, in v1. */
  readonly maxInFlight = MAX_IN_FLIGHT;
  /** When a send last settled, which is when the pool decides a slot went idle. */
  lastUsedAt: number;

  private readonly decoder = new FrameDecoder();
  private readonly pending = new Map<string, Pending>();
  private readonly closeListeners: ((reason: HoardDBError | undefined) => void)[] = [];
  private readonly addressText: string;
  private keyFingerprint = '';
  private isClosed = false;
  /** The server's own refusal of this connection (a zero-ID ERROR with nothing in flight), if any. */
  private serverRefusal: HoardDBError | undefined;

  private constructor(
    private readonly socket: TLSSocket,
    target: DialTarget,
    private readonly now: () => number,
  ) {
    this.addressText = addressOf(target.host, target.port);
    this.lastUsedAt = this.now();

    // No reader yet: until the key is accepted the socket stays paused, so whatever an untrusted peer
    // sends waits in the kernel and the stream's small high-water buffer, never in the decoder.
    this.socket.on('error', (error: NodeJS.ErrnoException) => {
      this.destroy(this.connectionError(`the socket failed (${String(error.code ?? error.errno ?? error.message)})`));
    });
    this.socket.on('end', () => this.destroy(this.connectionError('the server ended the connection')));
    this.socket.on('close', () => this.destroy(this.connectionError('the server closed the connection')));
  }

  get address(): string {
    return this.addressText;
  }

  get fingerprint(): string {
    return this.keyFingerprint;
  }

  get inFlight(): number {
    return this.pending.size;
  }

  get closed(): boolean {
    return this.isClosed;
  }

  /** Called by dial once the trust policy has accepted the key. */
  trusted(fingerprint: string): void {
    this.keyFingerprint = fingerprint;
  }

  /** Attach the frame reader, which also resumes the paused socket. Only dial calls it, after trust. */
  private startReading(): void {
    this.socket.on('data', (chunk: Buffer) => this.read(chunk));
  }

  /**
   * Write one request and hand back the frame that answers it. An ERROR frame resolves like any
   * other: only the caller knows what an error payload means.
   */
  send(opcode: number, payload: Uint8Array, options: SendOptions): Promise<Frame> {
    return this.sendWithId(opcode, newRequestId(), payload, options);
  }

  /**
   * The same as send with a request ID the caller chose, so a vector's own ID can be sent and its
   * echo checked. Nothing else in the driver has a reason to pick an ID.
   */
  async sendWithId(
    opcode: number,
    requestId: Uint8Array,
    payload: Uint8Array,
    options: SendOptions,
  ): Promise<Frame> {
    const operation = operationOf(opcode);

    // Every refusal before the write below carries writeOutcome not_applied: not a byte of the
    // request left this process, so the caller may repeat even a push.
    if (this.pending.size >= this.maxInFlight) {
      throw new InternalError({
        message: 'a connection was handed out while busy; this is a driver bug',
        operation,
        target: this.address,
        writeOutcome: 'not_applied',
      });
    }
    // A destroyed socket drops writes without a word, which would leave the request waiting out
    // its timeout for an answer nobody is going to send.
    if (this.isClosed) {
      // The server's own sentence beats ours: "connection budget full" names the fix, "closed" does not.
      throw this.serverRefusal ?? notSent(this.connectionError('the connection was closed before the request was written'));
    }
    const { signal } = options;
    if (signal?.aborted === true) {
      throw new AbortedError({
        message: `${operation} on ${this.address} was aborted.`,
        operation,
        target: this.address,
        writeOutcome: 'not_applied',
        cause: signal.reason,
      });
    }

    try {
      return await new Promise<Frame>((resolveFrame, rejectFrame) => {
        const hex = requestIdHex(requestId);
        const onAbort = (): void => {
          this.destroy(
            new AbortedError({
              message: `${operation} on ${this.address} was aborted.`,
              operation,
              target: this.address,
              cause: signal?.reason,
            }),
          );
        };

        const timer = setTimeout(() => {
          this.destroy(
            new RequestTimeoutError({
              message: `${operation} on ${this.address} timed out after ${options.timeoutMs} ms. For a slow call raise { timeoutMs }; the connection was discarded.`,
              operation,
              target: this.address,
            }),
          );
        }, options.timeoutMs);
        signal?.addEventListener('abort', onAbort, { once: true });

        this.pending.set(hex, {
          opcode,
          expect: options.expect,
          resolve: resolveFrame,
          reject: rejectFrame,
          settle: () => {
            clearTimeout(timer);
            signal?.removeEventListener('abort', onAbort);
          },
        });

        // The header and its payload are one write on the wire: a reader between them would see a
        // frame with no body.
        try {
          this.socket.cork();
          let flushed = this.socket.write(encodeFrameHeader(opcode, requestId, payload.length));
          flushed = this.socket.write(payload) && flushed;
          this.socket.uncork();
          if (!flushed) void waitForDrain(this.socket);
        } catch (error) {
          this.destroy(this.connectionError(`the request could not be written (${(error as Error).message})`));
        }
      });
    } finally {
      this.lastUsedAt = this.now();
    }
  }

  /** Close the socket and refuse everything still in flight. `end()` is never the way out. */
  destroy(reason?: HoardDBError): void {
    if (this.isClosed) return;
    this.isClosed = true;
    this.socket.destroy();

    for (const [hex, pending] of [...this.pending]) {
      pending.settle();
      this.pending.delete(hex);
      pending.reject(reason ?? this.connectionError('the connection was closed with a request in flight'));
    }

    for (const listener of this.closeListeners) listener(reason);
    this.closeListeners.length = 0;
  }

  /** Called once per connection: with the reason a caller gave, or with what the socket did. */
  onClose(listener: (reason: HoardDBError | undefined) => void): void {
    this.closeListeners.push(listener);
  }

  private read(chunk: Uint8Array): void {
    try {
      this.decoder.push(chunk);
      for (let frame = this.decoder.next(); frame !== null; frame = this.decoder.next()) this.deliver(frame);
    } catch (error) {
      const refusal = error as FrameError;
      this.destroy(this.protocolError(refusal.message, this.inFlightOperation(), refusal.refusal));
    }
  }

  private deliver(frame: Frame): void {
    // A refusal with no request ID belongs to the connection, not to a request: it answers whatever
    // is in flight and then the socket is finished (handbook errors.md section 6).
    if (isZeroRequestId(frame.requestId)) {
      const inFlight = [...this.pending.values()][0];
      if (inFlight === undefined) {
        // The server may refuse a connection before it is asked anything: over its connection budget
        // it writes OVERLOADED as soon as the handshake is done (transport/tcp.go TCPListener.refuse).
        // That sentence is the reason this socket is finished, so it is kept, not replaced.
        if (frame.opcode !== Op.ERROR) {
          this.destroy(this.protocolError(`opcode ${opName(frame.opcode)} with request ID 0 while nothing was in flight`));
          return;
        }
        this.serverRefusal = notSent(this.refusalOf(frame));
        this.destroy(this.serverRefusal);
        return;
      }
      this.settleWith(inFlight, frame);
      this.destroy(this.connectionError('the server closed the connection after an in-band refusal', operationOf(inFlight.opcode)));
      return;
    }

    const pending = this.pending.get(requestIdHex(frame.requestId));
    if (pending === undefined) {
      this.destroy(this.protocolError(`a response to request ${requestIdHex(frame.requestId)} that is not in flight`));
      return;
    }
    if (!pending.expect.includes(frame.opcode) && frame.opcode !== Op.ERROR) {
      this.destroy(
        this.protocolError(
          `opcode ${opName(frame.opcode)} in answer to ${operationOf(pending.opcode)}`,
          operationOf(pending.opcode),
        ),
      );
      return;
    }
    this.settleWith(pending, frame);
  }

  private settleWith(pending: Pending, frame: Frame): void {
    this.pending.delete(requestIdHex(frame.requestId));
    pending.settle();
    pending.resolve(frame);
  }

  /** A connection-level ERROR frame, decoded; one that does not decode is a protocol error. */
  private refusalOf(frame: Frame): HoardDBError {
    try {
      return errorFromErrorPayload(frame.payload, { operation: 'connect', target: this.address });
    } catch (error) {
      return this.protocolError(`a refusal with request ID 0 that does not decode (${(error as Error).message})`);
    }
  }

  private inFlightOperation(): string {
    const [pending] = [...this.pending.values()];
    return pending === undefined ? 'connect' : operationOf(pending.opcode);
  }

  private protocolError(what: string, operation = 'connect', refusal?: FrameRefusal): ProtocolError {
    return new ProtocolError({
      message: `The server at ${this.address} sent ${what}. The connection was discarded.`,
      operation,
      target: this.address,
      ...(refusal === undefined ? {} : { refusal }),
    });
  }

  private connectionError(reason: string, operation = 'connect'): ConnectionError {
    return new ConnectionError({
      message: `The connection to ${this.address} failed during ${operation} (${reason}).`,
      operation,
      target: this.address,
    });
  }
}
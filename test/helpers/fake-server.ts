// SPDX-License-Identifier: Apache-2.0
//
// A fake hoardDB server in this process, speaking the real TLS handshake with a throwaway identity
// (handbook testing.md: the connection and the pool are proven against an in-process server written
// with the language's own TLS). It answers whole frames and counts the bytes it was given, which is
// how a test proves that an untrusted server received nothing at all.

import { createServer, type Server, type TLSSocket } from 'node:tls';

import { encodeDocument } from '../../src/codec/index.js';
import { FrameDecoder, encodeFrame, type Frame } from '../../src/wire/frame.js';
import type { TlsIdentity } from './tls-identity.js';

export interface FakeServerOptions {
  identity: TlsIdentity;
  /** `false` runs a server that serves no ALPN at all, so the client's check has something to refuse. */
  alpn?: string[] | false;
  onFrame: (frame: Frame, conn: FakeConnection) => void | Promise<void>;
  /** Runs once the handshake is done, before any frame: how a server that speaks first is played. */
  onConnect?: (conn: FakeConnection) => void;
}

export interface FakeConnection {
  readonly bytesReceived: number;
  /** The socket has closed, from either side. */
  readonly closed: boolean;
  reply(opcode: number, requestId: Uint8Array, payload: Uint8Array): void;
  replyDoc(opcode: number, requestId: Uint8Array, doc: Record<string, unknown>): void;
  /** Bytes the codec must never see whole: a hostile length, or half a frame. */
  writeRaw(bytes: Uint8Array): void;
  /** Bytes written but not yet taken by the kernel: what a client that stopped reading leaves here. */
  pendingWriteBytes(): number;
  /** Flush what was written, then close, as the real server's Close() does after a refusal. */
  end(): void;
  destroy(): void;
}

export interface FakeServer {
  readonly port: number;
  readonly connections: FakeConnection[];
  totalBytesReceived(): number;
  close(): Promise<void>;
}

class OpenConnection implements FakeConnection {
  private readonly decoder = new FrameDecoder();
  private received = 0;
  private chain: Promise<void> = Promise.resolve();
  /** After end() a reply goes nowhere, as on a server that closed; Node would destroy the socket instead and drop what was still unflushed. */
  private ended = false;

  constructor(
    private readonly socket: TLSSocket,
    private readonly onFrame: FakeServerOptions['onFrame'],
  ) {}

  get bytesReceived(): number {
    return this.received;
  }

  get closed(): boolean {
    return this.socket.closed;
  }

  receive(chunk: Buffer): void {
    this.received += chunk.length;
    try {
      this.decoder.push(chunk);
    } catch {
      this.socket.destroy();
      return;
    }

    // Frames are handed over one at a time, so a test never sees two answers out of order.
    for (;;) {
      let frame: Frame | null;
      try {
        frame = this.decoder.next();
      } catch {
        this.socket.destroy();
        return;
      }
      if (frame === null) return;

      const answered = frame;
      this.chain = this.chain.then(() => this.onFrame(answered, this)).catch(() => {
        // A handler that throws is a broken test: the client sees a dead socket rather than a hang.
        this.socket.destroy();
      });
    }
  }

  reply(opcode: number, requestId: Uint8Array, payload: Uint8Array): void {
    if (this.ended) return;
    this.socket.write(encodeFrame({ opcode, requestId, payload }));
  }

  replyDoc(opcode: number, requestId: Uint8Array, doc: Record<string, unknown>): void {
    this.reply(opcode, requestId, encodeDocument(doc));
  }

  writeRaw(bytes: Uint8Array): void {
    if (this.ended) return;
    this.socket.write(bytes);
  }

  pendingWriteBytes(): number {
    return this.socket.writableLength;
  }

  end(): void {
    this.ended = true;
    this.socket.end();
  }

  destroy(): void {
    this.socket.destroy();
  }
}

/** A hoardDB server on 127.0.0.1 with a free port, holding its own key for as long as the test needs it. */
export async function startFakeServer(options: FakeServerOptions): Promise<FakeServer> {
  const sockets = new Set<TLSSocket>();
  const connections: OpenConnection[] = [];

  const server: Server = createServer({
    key: options.identity.keyPem,
    cert: options.identity.certPem,
    // An empty list serves no protocol, which is how a server with no ALPN at all looks.
    ALPNProtocols: options.alpn === false ? [] : (options.alpn ?? ['hoarddb/1']),
    minVersion: 'TLSv1.3',
  });

  server.on('secureConnection', (socket: TLSSocket) => {
    sockets.add(socket);
    const connection = new OpenConnection(socket, options.onFrame);
    connections.push(connection);
    socket.on('data', (chunk: Buffer) => connection.receive(chunk));
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => socket.destroy());
    options.onConnect?.(connection);
  });

  server.on('tlsClientError', () => {
    // A handshake the fake refuses is an expected outcome of several tests, not a failure.
  });

  await new Promise<void>((resolveListening) => server.listen(0, '127.0.0.1', resolveListening));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('the fake server has no TCP port');

  return {
    port: address.port,
    connections,
    totalBytesReceived: () => connections.reduce((sum, connection) => sum + connection.bytesReceived, 0),
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolveClosed) => server.close(() => resolveClosed()));
    },
  };
}

/**
 * The AUTH_OK document a real server sends, with this moment's stamps, for a test to answer with.
 * Both token times are Unix seconds, as the server writes them (the server's
 * AuthResponse): 900 s of life, and a refresh chain that ends 12 hours after the first login.
 */
export function authOkDoc(extra: Record<string, unknown> = {}): Record<string, unknown> {
  const seconds = Math.floor(Date.now() / 1000);
  return {
    success: true,
    message: '',
    protocol_version: 1,
    server_version: 'fake',
    capabilities: ['pipelining', 'get_fast', 'write_concern', 'consistent_get', 'auth_token', 'bucket_rf'],
    token: 'tok-1',
    token_expires_at: BigInt(seconds + 900),
    token_deadline: BigInt(seconds + 43_200),
    password_min_length: 12,
    ...extra,
  };
}
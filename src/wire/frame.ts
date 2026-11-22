// SPDX-License-Identifier: Apache-2.0
//
// The frame codec of handbook/wire.md §2. A length word is checked before any body is
// buffered, so a hostile or broken peer cannot make the driver allocate from a number it has not
// yet accepted.

import { randomBytes } from 'node:crypto';

/** The version byte, the 4-byte length, the opcode and the 16-byte request ID. */
export const HEADER_BYTES = 22;
/** The smallest legal length word: an opcode and a request ID, with no payload. */
export const MIN_LENGTH = 17;
/** The largest legal length word: 32 MiB. */
export const MAX_LENGTH = 33_554_432;
/** The only protocol version there is. */
export const PROTOCOL_VERSION = 1;

/** The version byte and the length word: all a decoder may read before it can judge a frame. */
const PREFIX_BYTES = 5;
/** A request ID is 16 bytes wide, fixed. */
const REQUEST_ID_BYTES = 16;

export type FrameRefusal = 'length-too-small' | 'length-too-large' | 'bad-version' | 'truncated';

export interface Frame {
  opcode: number;
  requestId: Uint8Array;
  payload: Uint8Array;
}

/** A frame the codec will not accept, and which of the four rules it broke. */
export class FrameError extends Error {
  readonly refusal: FrameRefusal;

  constructor(refusal: FrameRefusal, message: string) {
    super(message);
    this.name = 'FrameError';
    this.refusal = refusal;
  }
}

function readLength(bytes: Uint8Array): number {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(1, true);
}

function checkPrefix(bytes: Uint8Array): number {
  const version = bytes[0]!;
  if (version !== PROTOCOL_VERSION) {
    throw new FrameError('bad-version', `frame version ${version} is not ${PROTOCOL_VERSION}`);
  }
  const length = readLength(bytes);
  if (length < MIN_LENGTH) {
    throw new FrameError(
      'length-too-small',
      `frame length ${length} is under ${MIN_LENGTH}, the size of an opcode and a request ID`,
    );
  }
  if (length > MAX_LENGTH) {
    throw new FrameError(
      'length-too-large',
      `frame length ${length} is over the ${MAX_LENGTH}-byte (32 MiB) frame limit`,
    );
  }
  return length;
}

function truncated(have: number, want: number): FrameError {
  return new FrameError('truncated', `the stream ended inside a frame: ${have} of ${want} bytes`);
}

function checkRequestId(requestId: Uint8Array): void {
  if (requestId.length !== REQUEST_ID_BYTES) {
    throw new Error(
      `a request ID is ${REQUEST_ID_BYTES} bytes, got ${requestId.length}: ` +
        `newRequestId() makes one, and the server answers with the 16 bytes it was sent`,
    );
  }
}

/** The 22 header bytes of a frame carrying `payloadLength` bytes of payload. */
export function encodeFrameHeader(
  opcode: number,
  requestId: Uint8Array,
  payloadLength: number,
): Uint8Array {
  if (MIN_LENGTH + payloadLength > MAX_LENGTH) {
    throw new FrameError(
      'length-too-large',
      `frame length ${MIN_LENGTH + payloadLength} is over the ${MAX_LENGTH}-byte (32 MiB) frame limit`,
    );
  }
  checkRequestId(requestId);
  const header = new Uint8Array(HEADER_BYTES);
  header[0] = PROTOCOL_VERSION;
  const length = MIN_LENGTH + payloadLength;
  header[1] = length & 0xff;
  header[2] = (length >>> 8) & 0xff;
  header[3] = (length >>> 16) & 0xff;
  header[4] = (length >>> 24) & 0xff;
  header[5] = opcode;
  header.set(requestId, 6);
  return header;
}

/** A whole frame in one buffer: the tests and small frames. */
export function encodeFrame(frame: Frame): Uint8Array {
  const header = encodeFrameHeader(frame.opcode, frame.requestId, frame.payload.length);
  const encoded = new Uint8Array(header.length + frame.payload.length);
  encoded.set(header, 0);
  encoded.set(frame.payload, header.length);
  return encoded;
}

function decodePrefixed(bytes: Uint8Array): Frame {
  const length = checkPrefix(bytes);
  const total = PREFIX_BYTES + length;
  if (bytes.length < total) {
    throw truncated(Math.max(0, bytes.length - HEADER_BYTES), length - MIN_LENGTH);
  }
  return {
    opcode: bytes[5]!,
    requestId: bytes.slice(6, 6 + REQUEST_ID_BYTES),
    payload: bytes.slice(HEADER_BYTES, total),
  };
}

/** One whole frame. Bytes after the first frame are ignored: a stream is {@link FrameDecoder}'s job. */
export function decodeFrame(bytes: Uint8Array): Frame {
  if (bytes.length < PREFIX_BYTES) {
    throw truncated(bytes.length, PREFIX_BYTES);
  }
  return decodePrefixed(bytes);
}

/** The smallest buffer the decoder grows from, so a stream of small frames does not reallocate per frame. */
const MIN_CAPACITY = 4096;
const EMPTY = new Uint8Array(0);

/**
 * Frames out of a byte stream. A version or a length word is refused as soon as the 5-byte
 * prefix has arrived, before the body it describes is buffered.
 */
export class FrameDecoder {
  // Every pushed chunk is copied into one buffer that doubles as it fills, never past the frame it is
  // assembling: keeping each chunk as its own object cost about a hundred bytes per chunk (a 4 MiB
  // frame a byte at a time held 475 MiB), and copying everything buffered on each push made a
  // 32 MiB frame in 16 KiB TLS records cost tens of seconds. Memory follows the bytes received.
  private buffer: Uint8Array = EMPTY;
  private start = 0;
  private stop = 0;
  private length = -1;

  push(chunk: Uint8Array): void {
    let offset = 0;
    // The prefix is judged before a byte of the body is kept, so a refused length costs nothing.
    if (this.length < 0 && this.bufferedBytes() < PREFIX_BYTES) {
      offset = Math.min(PREFIX_BYTES - this.bufferedBytes(), chunk.length);
      this.append(chunk.subarray(0, offset));
      this.judge();
    }
    if (offset < chunk.length) this.append(chunk.subarray(offset));
  }

  next(): Frame | null {
    this.judge();
    if (this.length < 0) return null;
    const total = PREFIX_BYTES + this.length;
    if (this.bufferedBytes() < total) return null;

    let frame: Frame;
    if (this.start === 0 && this.stop === total && this.buffer.length === total) {
      // The buffer is exactly this frame: hand its body over instead of copying 32 MiB again.
      frame = {
        opcode: this.buffer[5]!,
        requestId: this.buffer.slice(6, 6 + REQUEST_ID_BYTES),
        payload: this.buffer.subarray(HEADER_BYTES, total),
      };
      this.buffer = EMPTY;
      this.stop = 0;
    } else {
      // A copy, not a view: a small frame must not keep a large buffer alive.
      frame = decodePrefixed(this.buffer.subarray(this.start, this.start + total));
      this.start += total;
      if (this.start === this.stop) {
        this.start = 0;
        this.stop = 0;
      }
    }
    this.length = -1;
    return frame;
  }

  /** The stream ended. A partial frame is a protocol violation, not a quiet stop. */
  end(): void {
    this.judge();
    const buffered = this.bufferedBytes();
    if (buffered === 0) return;
    const have = this.length < 0 ? buffered : Math.max(0, buffered - HEADER_BYTES);
    const want = this.length < 0 ? HEADER_BYTES : this.length - MIN_LENGTH;
    this.buffer = EMPTY;
    this.start = 0;
    this.stop = 0;
    this.length = -1;
    throw truncated(have, want);
  }

  bufferedBytes(): number {
    return this.stop - this.start;
  }

  /** Reads the 5-byte prefix and judges it, as soon as one is buffered. */
  private judge(): void {
    if (this.length < 0 && this.bufferedBytes() >= PREFIX_BYTES) {
      this.length = checkPrefix(this.buffer.subarray(this.start, this.start + PREFIX_BYTES));
    }
  }

  private append(bytes: Uint8Array): void {
    if (bytes.length === 0) return;
    this.reserve(bytes.length);
    this.buffer.set(bytes, this.stop);
    this.stop += bytes.length;
  }

  /** Room for `extra` more bytes: slide what is left to the front, else grow by doubling. */
  private reserve(extra: number): void {
    const live = this.stop - this.start;
    const needed = live + extra;
    if (this.stop + extra <= this.buffer.length) return;
    if (needed <= this.buffer.length) {
      this.buffer.copyWithin(0, this.start, this.stop);
    } else {
      let capacity = Math.max(needed, this.buffer.length * 2, MIN_CAPACITY);
      // Never more than the frame being assembled, once its accepted length is known.
      const frameBytes = this.length < 0 ? 0 : PREFIX_BYTES + this.length;
      if (frameBytes >= needed) capacity = Math.min(capacity, frameBytes);
      const grown = new Uint8Array(capacity);
      grown.set(this.buffer.subarray(this.start, this.stop));
      this.buffer = grown;
    }
    this.start = 0;
    this.stop = live;
  }
}

/** 16 random bytes: the server echoes them verbatim to correlate the answer. */
export function newRequestId(): Uint8Array {
  return randomBytes(REQUEST_ID_BYTES);
}

/** Lowercase hex, for logs, vectors and error messages. */
export function requestIdHex(id: Uint8Array): string {
  let hex = '';
  for (const byte of id) hex += byte.toString(16).padStart(2, '0');
  return hex;
}

/** A connection-level refusal carries an all-zero request ID. */
export function isZeroRequestId(id: Uint8Array): boolean {
  return id.every((byte) => byte === 0);
}
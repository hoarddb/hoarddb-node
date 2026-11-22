// SPDX-License-Identifier: Apache-2.0

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';

import { bytesToHex, hexToBytes, vectorNamed, vectorsOfKind, type Vector } from '../helpers/vectors.js';
import {
  HEADER_BYTES,
  MAX_LENGTH,
  MIN_LENGTH,
  PROTOCOL_VERSION,
  FrameDecoder,
  FrameError,
  decodeFrame,
  encodeFrame,
  encodeFrameHeader,
  isZeroRequestId,
  newRequestId,
  requestIdHex,
} from '../../src/wire/frame.js';
import { Op, opName } from '../../src/wire/opcodes.js';

interface FrameExpect {
  result: string;
  version?: number;
  length?: number;
  opcode?: number;
  request_id_hex?: string;
  payload_hex?: string;
  refuse_because?: string;
}

interface DecodeExpect {
  request_id_zero?: boolean;
}

function frameBytes(vector: Vector): Uint8Array {
  return hexToBytes(String(vector.frame_hex));
}

function caughtBy(run: () => void): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  return undefined;
}

function frameVectorsOf(expect: (check: FrameExpect) => boolean): Vector[] {
  return vectorsOfKind('frame').filter((vector) => expect(vector.expect as FrameExpect));
}

test('every accepting frame vector decodes to its expect', () => {
  const accepting = frameVectorsOf((expect) => expect.result === 'accept');
  assert.ok(accepting.length >= 3, `expected at least 3 accepting frame vectors, found ${accepting.length}`);

  for (const vector of accepting) {
    const expect = vector.expect as FrameExpect;
    assert.equal(expect.version, 1, `${vector.name}: the vector declares version 1`);
    assert.equal(PROTOCOL_VERSION, 1, `${vector.name}: the codec speaks version 1`);

    const frame = decodeFrame(frameBytes(vector));
    assert.equal(frame.opcode, expect.opcode, `${vector.name}: opcode`);
    assert.equal(requestIdHex(frame.requestId), expect.request_id_hex, `${vector.name}: request ID`);
    assert.equal(frame.requestId.length, 16, `${vector.name}: request ID is 16 bytes`);
    assert.equal(bytesToHex(frame.payload), expect.payload_hex ?? '', `${vector.name}: payload`);
    assert.equal(frame.payload.length, (expect.length ?? MIN_LENGTH) - MIN_LENGTH, `${vector.name}: payload length`);
    assert.equal(
      bytesToHex(encodeFrame(frame)),
      vector.frame_hex,
      `${vector.name}: re-encodes to the frame byte for byte`,
    );
  }
});

test('every refusing frame vector is refused with its reason', () => {
  const refusing = frameVectorsOf((expect) => expect.result === 'refuse');
  assert.equal(refusing.length, 4, `expected 4 refusing frame vectors, found ${refusing.length}`);

  for (const vector of refusing) {
    const refusal = (vector.expect as FrameExpect).refuse_because;
    const error = caughtBy(() => decodeFrame(frameBytes(vector)));
    assert.ok(error instanceof FrameError, `${vector.name}: expected a FrameError, got ${String(error)}`);
    assert.equal(error.refusal, refusal, `${vector.name}: refusal`);
  }
});

test('the decoder refuses an oversized length before buffering the body', () => {
  const vector = vectorNamed('frame refused: length over 32 MiB');
  const decoder = new FrameDecoder();
  const error = caughtBy(() => decoder.push(frameBytes(vector)));

  assert.ok(error instanceof FrameError, `expected a FrameError, got ${String(error)}`);
  assert.equal(error.refusal, 'length-too-large', 'refusal');
  assert.equal(
    error.message,
    `frame length ${MAX_LENGTH + 1} is over the ${MAX_LENGTH}-byte (32 MiB) frame limit`,
    'message',
  );
  assert.ok(
    decoder.bufferedBytes() <= 22,
    `buffered ${decoder.bufferedBytes()} bytes after refusing, want at most ${HEADER_BYTES}`,
  );
});

test('the decoder reassembles a frame split into one-byte chunks', () => {
  const vector = vectorNamed('frame: a BSON payload');
  const expect = vector.expect as FrameExpect;
  const bytes = frameBytes(vector);
  const decoder = new FrameDecoder();

  for (let offset = 0; offset < bytes.length - 1; offset += 1) {
    decoder.push(bytes.subarray(offset, offset + 1));
    assert.equal(decoder.next(), null, `no frame after ${offset + 1} of ${bytes.length} bytes`);
  }
  decoder.push(bytes.subarray(bytes.length - 1));

  const frame = decoder.next();
  assert.ok(frame !== null, 'the last byte completes the frame');
  assert.equal(frame.opcode, expect.opcode, `${vector.name}: opcode`);
  assert.equal(requestIdHex(frame.requestId), expect.request_id_hex, `${vector.name}: request ID`);
  assert.equal(bytesToHex(frame.payload), expect.payload_hex ?? '', `${vector.name}: payload`);
  assert.equal(decoder.next(), null, 'the frame is delivered once');
  assert.equal(decoder.bufferedBytes(), 0, 'nothing is left buffered');
});

test('the decoder returns two frames pushed in one chunk', () => {
  const first = vectorNamed('frame: an empty payload');
  const second = vectorNamed('frame: a BSON payload');
  const decoder = new FrameDecoder();
  decoder.push(new Uint8Array([...frameBytes(first), ...frameBytes(second)]));

  const head = decoder.next();
  assert.ok(head !== null, 'the first frame is returned');
  assert.equal(head.opcode, Op.PING, 'the first frame is the PING');
  assert.equal(head.payload.length, 0, 'the first frame carries no payload');

  const tail = decoder.next();
  assert.ok(tail !== null, 'the second frame is returned');
  assert.equal(tail.opcode, Op.GET, 'the second frame is the GET');
  assert.equal(
    bytesToHex(tail.payload),
    (second.expect as FrameExpect).payload_hex ?? '',
    'the second frame keeps its payload whole',
  );

  assert.equal(decoder.next(), null, 'no third frame is buffered');
  assert.equal(decoder.bufferedBytes(), 0, 'nothing is left buffered');
});

test('the decoder takes a 32 MiB frame in 16 KiB chunks without copying it per chunk', () => {
  const payload = new Uint8Array(MAX_LENGTH - MIN_LENGTH);
  payload[0] = 7;
  payload[payload.length - 1] = 9;
  const bytes = encodeFrame({ opcode: Op.GET, requestId: newRequestId(), payload });
  // A TLS socket hands data over in records of at most 16 KiB. Copying everything buffered on each
  // push is about 2 000 chunks times 16 MiB on average: tens of seconds. Linear is well under one.
  const chunkBytes = 16 * 1024;
  const decoder = new FrameDecoder();
  const started = Date.now();
  for (let offset = 0; offset < bytes.length; offset += chunkBytes) {
    decoder.push(bytes.subarray(offset, offset + chunkBytes));
  }
  const frame = decoder.next();
  const elapsedMs = Date.now() - started;

  assert.ok(frame !== null, 'the whole frame is returned');
  assert.equal(frame.payload.length, payload.length, 'the payload is whole');
  assert.equal(frame.payload[0], 7);
  assert.equal(frame.payload[frame.payload.length - 1], 9);
  assert.equal(decoder.bufferedBytes(), 0, 'nothing is left buffered');
  assert.ok(elapsedMs < 3_000, `reassembling 32 MiB took ${elapsedMs} ms`);
});

/** A full collection, so what the decoder still holds is all that is left on the heap. */
function collectGarbage(): void {
  setFlagsFromString('--expose-gc');
  (runInNewContext('gc') as () => void)();
}

test('the decoder holds a frame pushed in one-byte chunks in one buffer, not one object per chunk', () => {
  const MIB = 1024 * 1024;
  const payload = new Uint8Array(2 * MIB - MIN_LENGTH);
  payload[payload.length - 1] = 9;
  const bytes = encodeFrame({ opcode: Op.GET, requestId: newRequestId(), payload });
  const decoder = new FrameDecoder();

  collectGarbage();
  const before = process.memoryUsage();
  for (let offset = 0; offset < bytes.length - 1; offset += 1) {
    decoder.push(bytes.subarray(offset, offset + 1));
  }
  collectGarbage();
  const after = process.memoryUsage();
  // Keeping each pushed chunk as its own object costs about a hundred bytes per chunk whatever
  // its size: a 2 MiB frame a byte at a time held over 150 MB. One growing copy holds the bytes.
  const grownBytes = after.heapUsed - before.heapUsed + (after.arrayBuffers - before.arrayBuffers);
  assert.ok(grownBytes < 16 * MIB, `holding ${bytes.length - 1} buffered bytes grew memory by ${grownBytes} bytes`);

  decoder.push(bytes.subarray(bytes.length - 1));
  const frame = decoder.next();
  assert.ok(frame !== null, 'the last byte completes the frame');
  assert.equal(frame.payload.length, payload.length);
  assert.equal(frame.payload[frame.payload.length - 1], 9);
  assert.equal(decoder.bufferedBytes(), 0, 'nothing is left buffered');
});

test('end() inside a frame is truncated', () => {
  const vector = vectorNamed('frame refused: truncated body');
  const decoder = new FrameDecoder();
  decoder.push(frameBytes(vector));
  assert.equal(decoder.next(), null, 'the frame is not complete');

  const error = caughtBy(() => decoder.end());
  assert.ok(error instanceof FrameError, `expected a FrameError, got ${String(error)}`);
  assert.equal(error.refusal, 'truncated', 'refusal');
  assert.equal(
    error.message,
    'the stream ended inside a frame: 2 of 10 bytes',
    'message counts the payload bytes that arrived against the bytes the length promised',
  );

  const empty = new FrameDecoder();
  empty.end();
});

test('every decode vector\'s frame parses', () => {
  const decodeVectors = vectorsOfKind('decode');
  assert.ok(decodeVectors.length >= 14, `expected at least 14 decode vectors, found ${decodeVectors.length}`);

  for (const vector of decodeVectors) {
    const expect = vector.expect as DecodeExpect;
    const frame = decodeFrame(frameBytes(vector));
    assert.equal(frame.requestId.length, 16, `${vector.name}: request ID is 16 bytes`);
    assert.equal(
      isZeroRequestId(frame.requestId),
      expect.request_id_zero === true,
      `${vector.name}: the request ID is all zero exactly when the vector says so`,
    );
  }
});

test('encodeFrameHeader refuses a payload over the limit', () => {
  const error = caughtBy(() => encodeFrameHeader(Op.PUT, newRequestId(), MAX_LENGTH - MIN_LENGTH + 1));
  assert.ok(error instanceof FrameError, `expected a FrameError, got ${String(error)}`);
  assert.equal(error.refusal, 'length-too-large', 'refusal');
  assert.equal(
    error.message,
    `frame length ${MAX_LENGTH + 1} is over the ${MAX_LENGTH}-byte (32 MiB) frame limit`,
    'message',
  );

  const atTheLimit = encodeFrameHeader(Op.PUT, newRequestId(), MAX_LENGTH - MIN_LENGTH);
  assert.equal(atTheLimit.length, HEADER_BYTES, 'the header is 22 bytes');
  assert.equal(atTheLimit[0], PROTOCOL_VERSION, 'the version byte comes first');
});

test('opName names known opcodes and marks unknown ones', () => {
  assert.equal(opName(0x10), 'PUT');
  assert.equal(opName(Op.AUTH), 'AUTH');
  assert.equal(opName(Op.ERROR), 'ERROR');
  assert.equal(opName(0x05), 'UNKNOWN(0x05)');
  assert.equal(opName(0x8f), 'UNKNOWN(0x8f)');
  assert.equal(opName(0), 'UNKNOWN(0x00)');
});
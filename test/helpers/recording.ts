// SPDX-License-Identifier: Apache-2.0
//
// A client whose calls never leave the process. Every request is encoded by the real encodeRequest,
// recorded with its bytes, and answered from a map the test wrote or from a vector's own answer. It is
// how the request-shape tests check what a verb sends, byte for byte, without a socket (build doc
// step 11).

import assert from 'node:assert/strict';

import { createClient } from '../../src/client-core.js';
import { decodeDocument, encodeDocument, extendedJsonFromBytes, valuesFromExtendedJson } from '../../src/codec/index.js';
import type { SendOptions } from '../../src/connection.js';
import type { Pool } from '../../src/pool.js';
import type { Frame } from '../../src/wire/frame.js';
import { call, countRefusal, type CallContext, type CallSpec, type CallStats } from '../../src/call.js';
import { resolveOptions } from '../../src/options.js';
import type { Client, ConnectOptions } from '../../src/types.js';
import { Op, type OpName } from '../../src/wire/opcodes.js';
import { assertRequestMatches } from './compare.js';
import type { Vector } from './vectors.js';

/** An answer computed from the request; it may throw a refusal, as an ERROR frame would surface. */
export type AnswerFrom = (request: { op: OpName; fields: Record<string, unknown> }) => Record<string, unknown>;

/** Answers the server sends as an ERROR frame (the vector's response opcode is ERROR), not as the verb's own reply. */
const errorAnswers = new WeakSet<object>();

export interface RecordedRequest {
  op: OpName;
  fields: Record<string, unknown>;
  bytes: Uint8Array;
}

/** The capabilities of a server that has every feature the build doc's tests use. */
const RECORDING_CAPABILITIES: readonly string[] = [
  'pipelining',
  'get_fast',
  'write_concern',
  'consistent_get',
  'auth_token',
  'bucket_rf',
];

/**
 * A client on a recording call: nothing is dialled, and every request the verbs make is kept. The
 * request goes through the driver's real call() (src/call.ts): the write concern, the encoding, the
 * outcome rules and the decoding are the driver's own; only the socket is replaced, by a connection
 * that records the payload it is given and answers with the encoded answer. So a shape test sees what
 * the driver would put on the wire, and nothing this helper adds.
 */
export function recordingClient(
  responses: Map<OpName, Record<string, unknown> | AnswerFrom>,
  uri = 'hoarddb://admin@localhost:7433/app',
  capabilities: readonly string[] = RECORDING_CAPABILITIES,
  options?: ConnectOptions,
): { client: Client; sent: RecordedRequest[]; stats: CallStats } {
  const sent: RecordedRequest[] = [];
  const stats: CallStats = { requests: 0, retries: 0, errors: {} };
  const opByCode = new Map((Object.keys(Op) as OpName[]).map((name) => [Op[name] as number, name]));

  const connection = {
    address: 'recording:7433',
    send: async (opcode: number, payload: Uint8Array, options: SendOptions): Promise<Frame> => {
      const op = opByCode.get(opcode);
      if (op === undefined) throw new Error(`the driver sent an unknown opcode ${opcode}`);
      const fields = payload.length === 0 ? {} : decodeDocument(payload, 'safe');
      sent.push({ op, fields, bytes: payload });
      const answer = responses.get(op);
      if (answer === undefined) throw new Error(`no answer is recorded for ${op}`);
      // A function answers from the request (and may throw, as the server's ERROR frame would).
      if (typeof answer === 'object' && errorAnswers.has(answer)) {
        return { opcode: Op.ERROR, requestId: new Uint8Array(16), payload: encodeDocument(answer) };
      }
      const document = typeof answer === 'function' ? answer({ op, fields }) : answer;
      return { opcode: options.expect[0] ?? opcode, requestId: new Uint8Array(16), payload: encodeDocument(document) };
    },
  };
  const lease = { connection, release: (): void => undefined, discard: (): void => undefined };
  const pool = { acquire: async () => lease } as unknown as Pool;
  const context: CallContext = {
    pool,
    requestTimeoutMs: 5_000,
    int64: 'safe',
    random: () => 0,
    now: Date.now,
    capabilities: () => new Set(capabilities),
    serverVersion: () => 'recording',
    stats,
    closed: () => false,
  };

  const client = createClient({
    countRefusal: (error: unknown) => countRefusal(stats, error),
    call: (spec: CallSpec) => call(context, spec),
    options: resolveOptions(uri, options, {}),
    serverInfo: () => ({
      version: 'recording',
      protocolVersion: 1,
      capabilities: new Set(capabilities),
    }),
    poolStats: () => ({
      point: { open: 0, inUse: 0, waiting: 0 },
      bulk: { open: 0, inUse: 0, waiting: 0 },
      requests: sent.length,
      retries: 0,
      errors: { ...stats.errors },
    }),
    close: async () => undefined,
  });
  return { client, sent, stats };
}

/** The answer a vector records, keyed by the operation its request names. */
export function answerTo(vector: Vector): Map<OpName, Record<string, unknown>> {
  const request = vector['request'] as { opcode_name: OpName };
  const response = vector['response'] as { opcode_name: string; payload_json: Record<string, unknown> };
  const document = valuesFromExtendedJson(response.payload_json, 'safe');
  if (response.opcode_name === 'ERROR') errorAnswers.add(document);
  return new Map([[request.opcode_name, document]]);
}

/** The request a verb sent matches the vector's request: opcode, allowed fields and payload. */
export function assertSentAs(sent: RecordedRequest | undefined, vector: Vector): void {
  const request = vector['request'] as {
    opcode_name: string;
    payload_json: Record<string, unknown>;
    allowed_fields: string[];
  };
  assert.ok(sent !== undefined, `${vector.name}: no request was recorded`);
  assert.equal(sent.op, request.opcode_name, `${vector.name}: the opcode`);
  assertRequestMatches(extendedJsonFromBytes(sent.bytes), request.payload_json, request.allowed_fields);
}

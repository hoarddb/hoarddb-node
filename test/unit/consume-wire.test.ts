// SPDX-License-Identifier: Apache-2.0
//
// consume against a fake server that sends real ERROR frames and drops real connections, so the
// classification of a failed claim or ack is proven on the errors the driver actually builds from the
// wire (handbook api-go.md section 5.2: back off and continue vs end). The recording tests prove the
// loop; these prove the errors it is handed.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { connect } from '../../src/client.js';
import { encodeDocument } from '../../src/codec/index.js';
import {
  AbortedError,
  ClaimEntryTooLargeError,
  InternalError,
  InvalidArgumentError,
  NotFoundError,
  PermissionDeniedError,
} from '../../src/errors.js';
import type { Client, ConnectOptions } from '../../src/types.js';
import { Op } from '../../src/wire/opcodes.js';
import type { Frame } from '../../src/wire/frame.js';
import { authOkDoc, startFakeServer, type FakeConnection, type FakeServer } from '../helpers/fake-server.js';
import { makeTlsIdentity, removeTlsIdentity, type TlsIdentity } from '../helpers/tls-identity.js';
import { EMPTY_CLAIM, claimAnswer, leaseAnswer } from '../helpers/leases.js';

let identity: TlsIdentity;
const servers: FakeServer[] = [];
const clients: Client[] = [];

before(() => {
  identity = makeTlsIdentity();
});

after(async () => {
  for (const client of clients) await client.close({ timeoutMs: 500 }).catch(() => undefined);
  for (const server of servers) await server.close();
  removeTlsIdentity(identity);
});

type Script = (frame: Frame, conn: FakeConnection, seen: { claims: number; acks: number }) => void;

async function bucketOn(script: Script): Promise<{ queue: ReturnType<Client['database']>['fifo'] extends (n: string) => infer B ? B : never; seen: { claims: number; acks: number } }> {
  const seen = { claims: 0, acks: 0 };
  const server = await startFakeServer({
    identity,
    onFrame: (frame, conn) => {
      if (frame.opcode === Op.AUTH) {
        conn.replyDoc(Op.AUTH_OK, frame.requestId, authOkDoc());
        return;
      }
      if (frame.opcode === Op.QUEUE_CLAIM) seen.claims += 1;
      if (frame.opcode === Op.QUEUE_ACK) seen.acks += 1;
      script(frame, conn, seen);
    },
  });
  servers.push(server);
  const options: ConnectOptions = { tls: { fingerprints: [identity.fingerprint], knownServersPath: false } };
  const client = await connect(`hoarddb://admin:pw-SECRET-1@127.0.0.1:${server.port}`, options);
  clients.push(client);
  return { queue: client.database('app').fifo('q'), seen };
}

function errorFrame(conn: FakeConnection, frame: Frame, fields: Record<string, unknown>): void {
  conn.reply(Op.ERROR, frame.requestId, encodeDocument(fields));
}

function answer(conn: FakeConnection, frame: Frame, doc: Record<string, unknown>): void {
  conn.replyDoc(frame.opcode, frame.requestId, doc);
}

async function runUntil(
  queue: Awaited<ReturnType<typeof bucketOn>>['queue'],
  until: () => boolean,
): Promise<unknown> {
  const controller = new AbortController();
  const outcome = queue.consume(() => undefined, { signal: controller.signal }).then(
    () => undefined,
    (error: unknown) => error,
  );
  const started = Date.now();
  let ended = false;
  void outcome.then(() => {
    ended = true;
  });
  while (!until() && !ended && Date.now() - started < 8_000) await new Promise((resolve) => setTimeout(resolve, 5));
  controller.abort();
  return outcome;
}

const CONTINUES: [string, Script][] = [
  ['UNAVAILABLE', (frame, conn, seen) => (seen.claims === 1 ? errorFrame(conn, frame, { code: 6, message: 'the owner is down', write_outcome: 'not_applied' }) : answer(conn, frame, EMPTY_CLAIM))],
  ['UNAVAILABLE with an unknown outcome', (frame, conn, seen) => (seen.claims === 1 ? errorFrame(conn, frame, { code: 6, message: 'the owner changed', write_outcome: 'unknown' }) : answer(conn, frame, EMPTY_CLAIM))],
  ['TIMEOUT', (frame, conn, seen) => (seen.claims === 1 ? errorFrame(conn, frame, { code: 7, message: 'write concern timed out', write_outcome: 'applied' }) : answer(conn, frame, EMPTY_CLAIM))],
  ['OVERLOADED', (frame, conn, seen) => (seen.claims === 1 ? errorFrame(conn, frame, { code: 13, message: 'too many connections' }) : answer(conn, frame, EMPTY_CLAIM))],
  ['a lost connection', (frame, conn, seen) => (seen.claims === 1 ? conn.destroy() : answer(conn, frame, EMPTY_CLAIM))],
];

for (const [label, script] of CONTINUES) {
  test(`consume backs off and claims again after ${label} on a claim`, async () => {
    const { queue, seen } = await bucketOn(script);
    const outcome = await runUntil(queue, () => seen.claims >= 2);
    assert.ok(outcome instanceof AbortedError, `it ended only because it was stopped, not with ${String(outcome)}`);
    assert.ok(seen.claims >= 2);
  });
}

const ACK_CONTINUES: [string, (frame: Frame, conn: FakeConnection) => void][] = [
  ['UNAVAILABLE', (frame, conn) => errorFrame(conn, frame, { code: 6, message: 'ack unavailable' })],
  ['TIMEOUT', (frame, conn) => errorFrame(conn, frame, { code: 7, message: 'ack timed out', write_outcome: 'applied' })],
  ['OVERLOADED', (frame, conn) => errorFrame(conn, frame, { code: 13, message: 'too many connections' })],
  ['a lost answer', (_frame, conn) => conn.destroy()],
  ['an expired lease', (frame, conn) => answer(conn, frame, { success: false, lease_state: 'expired', message: 'the lease expired' })],
  ['an unknown lease', (frame, conn) => answer(conn, frame, { success: false, lease_state: 'unknown', message: 'the lease is unknown' })],
];

for (const [label, onAck] of ACK_CONTINUES) {
  test(`consume goes on after ${label} on an ack`, async () => {
    const { queue, seen } = await bucketOn((frame, conn, counts) => {
      if (frame.opcode === Op.QUEUE_ACK) onAck(frame, conn);
      else answer(conn, frame, counts.claims === 1 ? claimAnswer(1) : EMPTY_CLAIM);
    });
    const outcome = await runUntil(queue, () => seen.claims >= 2);
    assert.ok(outcome instanceof AbortedError, `it ended only because it was stopped, not with ${String(outcome)}`);
    assert.ok(seen.claims >= 2, 'it claimed again');
    assert.equal(seen.acks, 1, 'the ack was not resent');
  });
}

const ENDS: [string, Record<string, unknown>, new (...args: never[]) => Error][] = [
  ['INVALID_ARGUMENT', { code: 4, message: 'invalid claim limit', write_outcome: 'not_applied' }, InvalidArgumentError],
  ['the hard cap', { code: 4, message: 'claim refused: the entry at the front is over the cap', write_outcome: 'not_applied' }, ClaimEntryTooLargeError],
  ['PERMISSION_DENIED', { code: 3, message: 'role app-reader cannot write', write_outcome: 'not_applied' }, PermissionDeniedError],
  ['NOT_FOUND', { code: 1, message: 'bucket "q" not found in database "app"', write_outcome: 'not_applied' }, NotFoundError],
  ['INTERNAL', { code: 5, message: 'disk failure', write_outcome: 'unknown' }, InternalError],
  ['an unknown code', { code: 99, message: 'a newer server' }, InternalError],
];

for (const [label, fields, expected] of ENDS) {
  test(`consume ends on ${label} on a claim, at the first one`, async () => {
    const { queue, seen } = await bucketOn((frame, conn) => errorFrame(conn, frame, fields));
    const outcome = await runUntil(queue, () => seen.claims >= 3);
    assert.ok(outcome instanceof expected, `rejected with ${String(outcome)}`);
    assert.equal(seen.claims, 1, 'one claim, then it ended');
  });
}

test('consume on a hash bucket ends: the in-band refusal is INVALID_ARGUMENT', async () => {
  const { queue, seen } = await bucketOn((frame, conn) => answer(conn, frame, { found: false, message: 'claim is not defined for hash buckets: a hash has no order to take from.' }));
  const outcome = await runUntil(queue, () => seen.claims >= 3);
  assert.ok(outcome instanceof InvalidArgumentError, `rejected with ${String(outcome)}`);
  assert.equal(seen.claims, 1);
});

test('consume releases the unacknowledged entries when stopped, over a real connection', async () => {
  let released = false;
  const { queue, seen } = await bucketOn((frame, conn, counts) => {
    if (frame.opcode === Op.QUEUE_RELEASE) {
      released = true;
      answer(conn, frame, leaseAnswer({ lease_state: 'released', released: 1n }));
    } else answer(conn, frame, counts.claims === 1 ? claimAnswer(1) : EMPTY_CLAIM);
  });
  const controller = new AbortController();
  const outcome = queue
    .consume(async (_delivery, signal) => {
      await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
      throw new Error('stopped');
    }, { signal: controller.signal })
    .then(() => undefined, (error: unknown) => error);
  while (seen.claims < 1) await new Promise((resolve) => setTimeout(resolve, 5));
  await new Promise((resolve) => setTimeout(resolve, 30));
  controller.abort();
  assert.ok((await outcome) instanceof AbortedError);
  assert.equal(released, true, 'a release was sent');
});

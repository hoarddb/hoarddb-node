// SPDX-License-Identifier: Apache-2.0
//
// The lease and dead-list vector rows replayed through the PUBLIC API (handbook testing.md leg 3 asks
// for the wire layer; this proves the verbs as well): each vector's setup runs raw on a real server,
// then the call the vector records is made with claim, ack, release, extend, deadList, requeue or
// discard, and what the verb returns or throws is compared with the vector's recorded answer. A row the
// driver refuses before sending (a claim limit above 100, a lease above an hour) must be refused with
// the same class and nothing sent; the server's own refusal of it is the wire replay's.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { valuesFromExtendedJson } from '../../src/codec/index.js';
import {
  DeadMoveRefusedError,
  InvalidArgumentError,
  LeaseExpiredError,
  LeaseUnknownError,
  connect,
  isHoardDBError,
  type AnyBucket,
  type Client,
  type Doc,
} from '../../src/index.js';
import { runVectorSetup, startServer, type TestServer } from '../helpers/server.js';
import { loadDriverVectors } from '../helpers/vectors.js';

const OPCODES = ['QUEUE_CLAIM', 'QUEUE_ACK', 'QUEUE_RELEASE', 'QUEUE_EXTEND', 'DEAD_LIST', 'DEAD_REQUEUE', 'DEAD_DISCARD'];

const rows = loadDriverVectors().vectors.filter((vector) => {
  const request = vector['request'] as { opcode_name?: string } | undefined;
  return vector.kind === 'exchange' && vector['topology'] === 'single' && vector['replay'] === true && OPCODES.includes(request?.opcode_name ?? '');
});

let server: TestServer;
let client: Client;

before(async () => {
  const file = loadDriverVectors();
  server = await startServer({
    user: file.server_env['HOARDDB_ROOT_USER'] ?? 'admin',
    password: file.server_env['HOARDDB_ROOT_PASSWORD'] ?? 'vectors-root-password',
    env: { HOARDDB_NODE_ID: 'vectors-node' },
  });
  client = await connect(server.uri(), { tls: { knownServersPath: false } });
});

after(async () => {
  await client?.close({ timeoutMs: 1_000 });
  await server?.stop();
});

interface Recorded {
  opcode_name: string;
  payload_json: Record<string, unknown>;
}

/** The recorded answer as plain JavaScript values, with a nested `$numberInt` read as a number. */
function plain(json: unknown): Record<string, unknown> {
  return valuesFromExtendedJson(json as Record<string, unknown>, 'safe');
}

function withoutIds(documents: unknown): unknown[] {
  return (documents as Doc[]).map(({ _id_, ...rest }) => {
    void _id_;
    return rest;
  });
}

async function outcomeOf(run: () => Promise<unknown>): Promise<{ value?: unknown; error?: unknown }> {
  try {
    return { value: await run() };
  } catch (error) {
    return { error };
  }
}

for (const vector of rows) {
  test(`the public API replays "${vector.name}"`, async () => {
    const request = vector['request'] as Recorded;
    const response = vector['response'] as { payload_json: Record<string, unknown>; vary: string[] };
    const recorded = plain(response.payload_json);
    const asked = plain(request.payload_json);
    const lease = (await runVectorSetup(vector, server)) ?? String(asked['lease_id']);
    const queue: AnyBucket = client.database(String(asked['database'])).bucket(String(asked['bucket']));
    const limit = asked['limit'] === undefined ? undefined : Number(asked['limit']);
    const leaseMs = asked['lease_ms'] === undefined ? undefined : Number(asked['lease_ms']);
    const error = vector['error'] as { name: string; message_contains?: string[] } | undefined;

    const selector = asked['all'] === true
      ? { all: true as const, ...(asked['after'] === undefined ? {} : { after: String(asked['after']) }) }
      : { byId: String(asked['dead_id']), ...(asked['after'] === undefined ? {} : { after: String(asked['after']) }) };

    const { value, error: thrown } = await outcomeOf(() => {
      switch (request.opcode_name) {
        case 'QUEUE_CLAIM':
          return queue.claim({ limit, lease: leaseMs });
        case 'QUEUE_ACK':
          return queue.ack(lease, asked['item_ids'] === undefined ? undefined : { itemIds: asked['item_ids'] as string[] });
        case 'QUEUE_RELEASE':
          return queue.release(lease);
        case 'QUEUE_EXTEND':
          return queue.extend(lease, leaseMs ?? 0);
        case 'DEAD_LIST':
          return queue.deadList({ limit, after: asked['after'] === undefined ? undefined : String(asked['after']) });
        case 'DEAD_REQUEUE':
          return queue.requeue(selector);
        default:
          return queue.discard(selector);
      }
    });

    // A server ERROR: the driver reports it as the class of its code, with the server's words.
    if (error !== undefined) {
      assert.ok(isHoardDBError(thrown), `${vector.name}: expected a refusal, got ${JSON.stringify(value)}`);
      assert.equal(thrown.code, error.name, vector.name);
      for (const part of error.message_contains ?? []) {
        // Rows the driver refuses itself (claim limit, lease range) say the same thing in the driver's words.
        if (!thrown.message.includes(part)) assert.equal(thrown.writeOutcome, 'not_applied', `${vector.name}: ${thrown.message}`);
      }
      return;
    }
    if (thrown !== undefined) {
      const message = String(recorded['message'] ?? '');
      if (request.opcode_name === 'QUEUE_CLAIM') {
        assert.ok(thrown instanceof InvalidArgumentError, `${vector.name}: ${String(thrown)}`);
        assert.equal((thrown as Error).message, message);
      } else if (recorded['lease_state'] === 'unknown') {
        assert.ok(thrown instanceof LeaseUnknownError, `${vector.name}: ${String(thrown)}`);
        assert.equal(thrown.message, message);
      } else if (recorded['lease_state'] === 'expired') {
        assert.ok(thrown instanceof LeaseExpiredError);
      } else {
        assert.ok(thrown instanceof DeadMoveRefusedError, `${vector.name}: ${String(thrown)}`);
        assert.deepEqual(
          thrown.result.refused,
          (recorded['refused'] as { dead_id: string; message: string }[]).map((refusal) => ({ deadId: refusal.dead_id, message: refusal.message })),
        );
        assert.equal(thrown.result.done, Number(recorded['done']));
      }
      return;
    }

    switch (request.opcode_name) {
      case 'QUEUE_CLAIM': {
        const claimed = value as Awaited<ReturnType<AnyBucket['claim']>>;
        assert.deepEqual(withoutIds(claimed.items.map((delivery) => delivery.document)), withoutIds(recorded['items'] ?? []), vector.name);
        assert.equal(claimed.items.length, ((recorded['items'] as unknown[]) ?? []).length);
        if (claimed.items.length > 0) {
          assert.equal(claimed.grantedMs, Number(recorded['lease_ms']));
          assert.equal(claimed.pending, Number(recorded['pending'] ?? 0));
          assert.deepEqual(
            claimed.items.map((delivery) => delivery.deliveries),
            ((recorded['deliveries'] as number[] | undefined) ?? claimed.items.map(() => 1)).map(Number),
          );
          if (!response.vary.includes('item_ids[]')) assert.deepEqual(claimed.items.map((delivery) => delivery.itemId), recorded['item_ids']);
        }
        break;
      }
      case 'QUEUE_ACK':
        assert.deepEqual(value, {
          state: recorded['lease_state'],
          acked: Number(recorded['acked'] ?? 0),
          missing: Number(recorded['missing'] ?? 0),
          remaining: Number(recorded['remaining'] ?? 0),
          message: '',
        });
        break;
      case 'QUEUE_RELEASE':
        assert.deepEqual(value, { state: recorded['lease_state'], released: Number(recorded['released'] ?? 0), message: '' });
        break;
      case 'QUEUE_EXTEND':
        assert.equal(value, Number(recorded['lease_ms']));
        break;
      case 'DEAD_LIST':
        assert.deepEqual((value as { items: unknown[] }).items, []);
        break;
      default:
        assert.deepEqual(value, {
          done: Number(recorded['done'] ?? 0),
          left: Number(recorded['left'] ?? 0),
          refused: [],
          message: String(recorded['message'] ?? ''),
        });
    }
  });
}

test('the lease and dead-list vector rows were found', () => {
  assert.ok(rows.length >= 17, `only ${rows.length} rows`);
});

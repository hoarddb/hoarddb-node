// SPDX-License-Identifier: Apache-2.0
//
// alterBucket against the frozen "alter bucket" vectors: the request each call makes must match
// the vector's request (opcode, allowed fields and payload), the result is read from the vector's own
// answer, and the two kinds of refusal keep their classes. An in-band refusal (success false) is an
// InvalidArgumentError the driver sends once; the ERROR frame that carries write_outcome not_applied
// is an UnavailableError a retry clears, which the driver resends within the call's deadline.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { connect } from '../../src/client.js';
import { encodeDocument, valuesFromExtendedJson } from '../../src/codec/index.js';
import { InvalidArgumentError, NotFoundError, UnavailableError, UnsupportedFeatureError } from '../../src/errors.js';
import type { ConnectOptions } from '../../src/types.js';
import { Op } from '../../src/wire/opcodes.js';
import { authOkDoc, startFakeServer, type FakeServer } from '../helpers/fake-server.js';
import { answerTo, assertSentAs, recordingClient } from '../helpers/recording.js';
import { makeTlsIdentity, removeTlsIdentity, type TlsIdentity } from '../helpers/tls-identity.js';
import { vectorNamed } from '../helpers/vectors.js';

let identity: TlsIdentity;
const servers: FakeServer[] = [];

before(() => {
  identity = makeTlsIdentity();
});

after(async () => {
  for (const server of servers) await server.close();
  removeTlsIdentity(identity);
});

const pinned = (): ConnectOptions['tls'] => ({ fingerprints: [identity.fingerprint], knownServersPath: false });

/** The answer a vector recorded, as the decoded document a fake server sends back. */
function recordedAnswer(name: string): Record<string, unknown> {
  const response = vectorNamed(name)['response'] as { payload_json: Record<string, unknown> };
  return valuesFromExtendedJson(response.payload_json, 'safe') as Record<string, unknown>;
}

const SUCCESS_ROWS = [
  { vector: 'alter bucket: raise the factor', factor: 3, database: 'v245', previous: 1, pending: ['node2', 'node3'], releasing: undefined },
  { vector: 'alter bucket: lower the factor', factor: 2, database: 'v246', previous: 3, pending: undefined, releasing: ['node2'] },
  { vector: 'alter bucket: declare the inherited factor', factor: 3, database: 'v247', previous: 3, pending: undefined, releasing: undefined },
  { vector: 'alter bucket: no change', factor: 2, database: 'v248', previous: 2, pending: undefined, releasing: undefined },
];

for (const row of SUCCESS_ROWS) {
  test(`alterBucket matches the ${row.vector} vector`, async () => {
    const vector = vectorNamed(row.vector);
    const { client, sent } = recordingClient(answerTo(vector));
    const result = await client.database(row.database).alterBucket('users', { replicationFactor: row.factor });
    assertSentAs(sent[0], vector);
    assert.equal(result.replicationFactor, row.factor);
    assert.equal(result.previousFactor, row.previous);
    assert.deepEqual(result.pending, row.pending);
    assert.deepEqual(result.releasing, row.releasing);
    assert.equal(result.message, recordedAnswer(row.vector)['message']);
  });
}

test('alterBucket sends database, name and replication_factor and no other member', async () => {
  const vector = vectorNamed('alter bucket: no change');
  const { client, sent } = recordingClient(answerTo(vector));
  await client.database('app').alterBucket('users', { replicationFactor: 2 });
  assert.deepEqual(Object.keys(sent[0]?.fields ?? {}).sort(), ['database', 'name', 'replication_factor']);
});

test('an in-band refusal is an InvalidArgumentError with the server sentence, sent once', async () => {
  const vector = vectorNamed('alter bucket: refused in-band');
  const { client, sent, stats } = recordingClient(answerTo(vector));
  await assert.rejects(
    client.database('v249').alterBucket('users', { replicationFactor: 4 }),
    (error: unknown) => {
      assert.ok(error instanceof InvalidArgumentError);
      assert.equal(error.operation, 'alterBucket');
      assert.equal(error.target, 'v249/users');
      assert.equal(error.message, recordedAnswer('alter bucket: refused in-band')['message']);
      assert.equal(error.retryable, false, 'the same request meets the same answer until an operator acts');
      return true;
    },
  );
  assert.equal(sent.length, 1);
  assert.deepEqual(stats.errors, { INVALID_ARGUMENT: 1 });
});

test('alterBucket without the bucket_rf capability sends nothing', async () => {
  const { client, sent } = recordingClient(new Map(), undefined, ['pipelining', 'auth_token']);
  await assert.rejects(
    client.database('app').alterBucket('users', { replicationFactor: 2 }),
    (error: unknown) => error instanceof UnsupportedFeatureError && error.message.includes('bucket_rf'),
  );
  assert.equal(sent.length, 0);
});

test('a replication factor below one, or not a whole number, is refused before anything is sent', async () => {
  const { client, sent } = recordingClient(answerTo(vectorNamed('alter bucket: no change')));
  for (const replicationFactor of [0, -1, 1.5, Number.NaN]) {
    await assert.rejects(
      client.database('app').alterBucket('users', { replicationFactor }),
      (error: unknown) => error instanceof InvalidArgumentError && error.message.includes('replicationFactor'),
    );
  }
  assert.equal(sent.length, 0);
});

test('UNAVAILABLE with write_outcome not_applied is resent until the server accepts', async () => {
  const refused = recordedAnswer('alter bucket: refused, retry later');
  const accepted = recordedAnswer('alter bucket: lower the factor');
  let requests = 0;
  const server = await startFakeServer({
    identity,
    onFrame: (frame, conn) => {
      if (frame.opcode === Op.AUTH) conn.replyDoc(Op.AUTH_OK, frame.requestId, authOkDoc());
      else if (frame.opcode === Op.ALTER_BUCKET) {
        requests += 1;
        if (requests <= 2) conn.replyDoc(Op.ERROR, frame.requestId, refused);
        else conn.replyDoc(Op.ALTER_BUCKET, frame.requestId, accepted);
      }
    },
  });
  servers.push(server);
  const client = await connect(`hoarddb://admin:pw-SECRET-1@127.0.0.1:${server.port}`, { tls: pinned() });
  try {
    const result = await client.database('app').alterBucket('orders002', { replicationFactor: 2 });
    assert.equal(result.replicationFactor, 2);
    assert.deepEqual(result.releasing, ['node2']);
    assert.equal(requests, 3, 'two refusals, then the answer');
  } finally {
    await client.close();
  }
});

test('when the deadline ends the waiting the refusal comes back retryable and not applied', async () => {
  const refused = recordedAnswer('alter bucket: refused, retry later');
  const server = await startFakeServer({
    identity,
    onFrame: (frame, conn) => {
      if (frame.opcode === Op.AUTH) conn.replyDoc(Op.AUTH_OK, frame.requestId, authOkDoc());
      else if (frame.opcode === Op.ALTER_BUCKET) conn.reply(Op.ERROR, frame.requestId, encodeDocument(refused));
    },
  });
  servers.push(server);
  const client = await connect(`hoarddb://admin:pw-SECRET-1@127.0.0.1:${server.port}`, { tls: pinned() });
  try {
    await assert.rejects(
      client.database('app').alterBucket('orders002', { replicationFactor: 2, timeoutMs: 400 }),
      (error: unknown) => {
        assert.ok(error instanceof UnavailableError);
        assert.equal(error.writeOutcome, 'not_applied');
        assert.equal(error.retryable, true, 'nothing changed and the retry is safe (errors.md section 6)');
        assert.match(error.message, /Run 'show buckets' on node2 and retry/);
        return true;
      },
    );
  } finally {
    await client.close();
  }
});

test('a missing bucket is a NotFoundError with the server sentence, sent once and never retried', async () => {
  // The vector "alter bucket: missing bucket": an ERROR frame NOT_FOUND, write_outcome not_applied, from
  // whichever node the call reached.
  const refusal = recordedAnswer('alter bucket: missing bucket');
  const message = String(refusal['message']);
  let requests = 0;
  const server = await startFakeServer({
    identity,
    onFrame: (frame, conn) => {
      if (frame.opcode === Op.AUTH) conn.replyDoc(Op.AUTH_OK, frame.requestId, authOkDoc());
      else if (frame.opcode === Op.ALTER_BUCKET) {
        requests += 1;
        conn.replyDoc(Op.ERROR, frame.requestId, refusal);
      }
    },
  });
  servers.push(server);
  const client = await connect(`hoarddb://admin:pw-SECRET-1@127.0.0.1:${server.port}`, { tls: pinned() });
  try {
    await assert.rejects(client.database('app').alterBucket('ghost001', { replicationFactor: 2 }), (error: unknown) => {
      assert.ok(error instanceof NotFoundError, `a NotFoundError, got ${String(error)}`);
      assert.equal(error.message, message);
      assert.equal(error.writeOutcome, 'not_applied');
      assert.equal(error.retryable, false);
      return true;
    });
    assert.equal(requests, 1, 'NOT_FOUND is not a retry');
  } finally {
    await client.close();
  }
});

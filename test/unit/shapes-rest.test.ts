// SPDX-License-Identifier: Apache-2.0
//
// Blobs, insertMany and store fields, checked against the frozen vectors on a recording client (build doc
// step 14). The batch that the server refuses whole is halved and resent in order, down to one document;
// no verb is left unbuilt except update, which step 20a builds.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import v8 from 'node:v8';
import vm from 'node:vm';

import { createClient } from '../../src/client-core.js';
import { Cursor } from '../../src/cursor.js';
import type { CallSpec } from '../../src/call.js';
import { connect } from '../../src/client.js';
import { BatchTooLargeError, InternalError, NotFoundError, ResultTooLargeError, type HoardDBError } from '../../src/errors.js';
import { resolveOptions } from '../../src/options.js';
import type { Client, Doc } from '../../src/types.js';
import { Op, type OpName } from '../../src/wire/opcodes.js';
import { answerTo, assertSentAs, recordingClient, type AnswerFrom } from '../helpers/recording.js';
import { vectorNamed } from '../helpers/vectors.js';
import { authOkDoc, startFakeServer } from '../helpers/fake-server.js';
import { makeTlsIdentity, removeTlsIdentity } from '../helpers/tls-identity.js';

const HELLO = new TextEncoder().encode('hello, hoardDB');
const NOTES = new TextEncoder().encode('Notes by the translator');

test('blob write matches its vector', async () => {
  const vector = vectorNamed('blob write');
  const { client, sent } = recordingClient(answerTo(vector));
  const written = await client
    .database('v081')
    .blob('files')
    .putBlob('hello.txt', HELLO, { metadata: { ContentType: 'text/plain' } });
  assertSentAs(sent[0], vector);
  assert.equal(written.key, 'hello.txt');
  assert.equal(written.size, 14);
});

test('blob read returns data and metadata, and NotFoundError for a missing key', async () => {
  const read = vectorNamed('blob read');
  const found = recordingClient(answerTo(read));
  const blob = await found.client.database('v095').blob('files').getBlob('hello.txt');
  assertSentAs(found.sent[0], read);
  assert.deepEqual(blob?.data, HELLO);
  assert.equal(blob?.size, 14);
  assert.deepEqual(blob?.metadata, { ContentType: 'text/plain' });

  const missing = vectorNamed('blob read of a key that does not exist');
  const none = recordingClient(answerTo(missing));
  await assert.rejects(none.client.database('v096').blob('files').getBlob('nothing.txt'), NotFoundError);
  assertSentAs(none.sent[0], missing);
});

test('delete on a blob bucket of a missing key is false', async () => {
  const vector = vectorNamed('delete on a blob bucket of a key that does not exist');
  const { client, sent } = recordingClient(answerTo(vector));
  assert.equal(await client.database('v083').blob('files').delete('nothing.txt'), false);
  assertSentAs(sent[0], vector);
});

test('insert many matches its vector and returns the ids', async () => {
  const vector = vectorNamed('insert many');
  const { client, sent } = recordingClient(answerTo(vector));
  const result = await client
    .database('v055')
    .hash('users')
    .insertMany([
      { Born: 1815, Name: 'Ada', _id_: 'ada' },
      { Born: 1906, Name: 'Grace', _id_: 'grace' },
    ]);
  assertSentAs(sent[0], vector);
  assert.deepEqual(result.ids, ['ada', 'grace']);
  assert.equal(result.count, 2);
});

/**
 * A client whose server refuses any batch larger than maxBatch, whole: in band (an old server), or with an
 * ERROR frame, code 17, whose write outcome is the one given (the current server).
 */
function refusingLargeBatches(maxBatch: number, tooLargeOutcome?: 'not_applied' | 'unknown'): { client: Client; batches: number[] } {
  const batches: number[] = [];
  const client = createClient({
    call: async (spec: CallSpec) => {
      const docs = spec.fields['data'] as { _id_: string }[];
      batches.push(docs.length);
      if (docs.length > maxBatch) {
        if (tooLargeOutcome !== undefined) {
          throw new BatchTooLargeError({ message: 'the batch is too large; halve the batch and resend each half', operation: 'insertMany', writeOutcome: tooLargeOutcome });
        }
        return { success: false, message: 'the batch is too large; none of it was written' };
      }
      return { success: true, ids: docs.map((doc) => doc._id_), count: docs.length };
    },
    options: resolveOptions('hoarddb://admin@localhost:7433/app', undefined, {}),
    serverInfo: () => ({ version: 'refusing', protocolVersion: 1, capabilities: new Set<string>() }),
    poolStats: () => ({
      point: { open: 0, inUse: 0, waiting: 0 },
      bulk: { open: 0, inUse: 0, waiting: 0 },
      requests: batches.length,
      retries: 0,
      errors: {},
    }),
    close: async () => undefined,
  });
  return { client, batches };
}

function fourDocs(): (Doc & { _id_: string })[] {
  return ['a', 'b', 'c', 'd'].map((id) => ({ Name: id, _id_: id }));
}

test('insertMany halves on nothing written', async () => {
  const { client, batches } = refusingLargeBatches(3);
  const result = await client.database('app').hash('users').insertMany(fourDocs());
  assert.deepEqual(batches, [4, 2, 2], 'the batch is halved at ceil(n/2) and the halves are sent in order');
  assert.equal(result.ids.length, 4);
  assert.equal(result.count, 4);
});

test('insertMany halves on a BATCH_TOO_LARGE that wrote nothing, and merges the halves in order', async () => {
  const { client, batches } = refusingLargeBatches(3, 'not_applied');
  const result = await client.database('app').hash('users').insertMany(fourDocs());
  assert.deepEqual(batches, [4, 2, 2], 'the batch is halved at ceil(n/2) and the halves are sent in order');
  assert.deepEqual(result.ids, ['a', 'b', 'c', 'd'], 'the receipts merge in the order the documents were given');
  assert.equal(result.count, 4);
});

test('insertMany never splits a BATCH_TOO_LARGE whose outcome is unknown, and surfaces it', async () => {
  const { client, batches } = refusingLargeBatches(3, 'unknown');
  await assert.rejects(client.database('app').hash('users').insertMany(fourDocs()), (error: unknown) => {
    assert.ok(error instanceof BatchTooLargeError);
    assert.equal(error.writeOutcome, 'unknown');
    return true;
  });
  assert.deepEqual(batches, [4], 'the batch is sent once: a cluster member may have applied it');
});

test('insertMany never splits a batch of one document, and surfaces it', async () => {
  const { client, batches } = refusingLargeBatches(0, 'not_applied');
  await assert.rejects(client.database('app').hash('users').insertMany([{ Name: 'a', _id_: 'a' }]), BatchTooLargeError);
  assert.deepEqual(batches, [1], 'a one-document batch is never split');
});

test('field push on fifo and heap store fields match their vectors', async () => {
  const fifo = vectorNamed('field push on a fifo store field');
  const fifoRun = recordingClient(answerTo(fifo));
  const queued = await fifoRun.client.database('v116').hash('User').field('ada', 'Purchases').push({ Item: 'tea' });
  assertSentAs(fifoRun.sent[0], fifo);
  assert.equal(typeof queued.entryId, 'string');

  const heap = vectorNamed('field push on a heap store field');
  const heapRun = recordingClient(answerTo(heap));
  await heapRun.client
    .database('v121')
    .hash('User')
    .field('ada', 'Books')
    .push({ Title: 'Sketch of the Analytical Engine' }, { priority: 7 });
  assertSentAs(heapRun.sent[0], heap);
});

test('field put and get on a blob store field', async () => {
  const put = vectorNamed('field put on a blob store field');
  const putRun = recordingClient(answerTo(put));
  const written = await putRun.client
    .database('v127')
    .hash('User')
    .field('ada', 'Data')
    .putBlob('notes.txt', NOTES, { metadata: { ContentType: 'text/plain' } });
  assertSentAs(putRun.sent[0], put);
  assert.equal(written.elementKey, 'notes.txt');

  const get = vectorNamed('field get on a blob store field');
  const getRun = recordingClient(answerTo(get));
  const read = await getRun.client.database('v128').hash('User').field('ada', 'Data').getBlob('notes.txt');
  assertSentAs(getRun.sent[0], get);
  assert.equal(read?.elementKey, 'notes.txt');
  assert.deepEqual(read?.data, NOTES);
  assert.deepEqual(read?.metadata, { ContentType: 'text/plain' });
});

test('field list passes next back unchanged', async () => {
  const vector = vectorNamed('field list');
  const { client, sent } = recordingClient(answerTo(vector));
  const cursor = client.database('v130').hash('User').field('ada', 'Purchases').list({ pageSize: 1 });
  const first = await cursor.next();
  assertSentAs(sent[0], vector);
  assert.deepEqual(first?.element, { Item: 'tea', _id_: 'normalised' });

  await cursor.next();
  const answer = answerTo(vector).get('FIELD_LIST');
  assert.ok(answer !== undefined);
  assert.deepEqual(sent[1]?.fields['after'], answer['next'], 'the second page passes the first page\'s next back');
});

test('no verb is left unbuilt except update', async () => {
  const everyOp = new Map<OpName, Record<string, unknown>>(
    (Object.keys(Op) as OpName[]).map((op) => [op, { success: true, found: false }]),
  );
  const { client } = recordingClient(everyOp);
  const hash = client.database('app').hash<Doc>('b');
  const blob = client.database('app').blob('f');
  const field = hash.field('k', 'f');
  const bytes = new Uint8Array([1, 2, 3]);

  const calls: [string, () => unknown][] = [
    ['stats', () => hash.stats()],
    ['drop', () => hash.drop()],
    ['count', () => hash.count({ a: 1 })],
    ['find', () => hash.find({ a: 1 })],
    ['findOne', () => hash.findOne()],
    ['distinct', () => hash.distinct('Name')],
    ['put', () => hash.put('k', {})],
    ['insert', () => hash.insert({})],
    ['insertMany', () => hash.insertMany([{}])],
    ['get', () => hash.get('k')],
    ['exists', () => hash.exists('k')],
    ['delete', () => hash.delete('k')],
    ['field', () => field],
    ['search', () => hash.search({ a: 1 })],
    ['range', () => client.database('app').btree('t').range({ gte: 'a' })],
    ['first', () => client.database('app').btree('t').first()],
    ['last', () => client.database('app').btree('t').last()],
    ['push', () => client.database('app').fifo('q').push({})],
    ['pop', () => client.database('app').fifo('q').pop()],
    ['peek', () => client.database('app').fifo('q').peek()],
    ['putBlob', () => blob.putBlob('k', bytes)],
    ['getBlob', () => blob.getBlob('k')],
    ['blob delete', () => blob.delete('k')],
    ['blob count', () => blob.count()],
    ['field push', () => field.push({})],
    ['field pop', () => field.pop()],
    ['field peek', () => field.peek()],
    ['field put', () => field.put('e', {})],
    ['field get', () => field.get('e')],
    ['field delete', () => field.delete('e')],
    ['field putBlob', () => field.putBlob('e', bytes)],
    ['field getBlob', () => field.getBlob('e')],
    ['field len', () => field.len()],
    ['field list', () => field.list()],
    ['field nested', () => field.field('e', 'g')],
  ];

  for (const [name, call] of calls) {
    const message = await notBuiltMessage(call);
    assert.equal(message, undefined, `${name} is not built: ${message}`);
  }

  // The check itself catches a stub (a synthetic one, so this test stays green once step 20a builds
  // update), including one that only fails when its cursor is driven.
  const stub = (): never => {
    throw new InternalError({ message: 'search is not built yet', operation: 'search' });
  };
  assert.equal(await notBuiltMessage(stub), 'search is not built yet');
  const stubCursor = new Cursor<Doc>(async () => stub(), { pageSize: 1, halveOnTooLarge: false });
  assert.equal(await notBuiltMessage(() => stubCursor), 'search is not built yet');
});

/**
 * Runs a verb as a program would (a cursor is driven to its first fetch, or nothing would be asked)
 * and returns the error message when the verb is a stub, else undefined.
 */
async function notBuiltMessage(call: () => unknown): Promise<string | undefined> {
  try {
    const returned = await call();
    if (returned instanceof Cursor) await returned.toArray();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return message.endsWith('is not built yet') ? message : undefined;
  }
  return undefined;
}

test('an error that is not a stub is not reported as one', async () => {
  // A verb refused by the server is built: the unbuilt check must tell it from a stub.
  const { client } = recordingClient(new Map([['GET', { found: false, message: 'GET is not supported on a fifo bucket' }]]));
  assert.equal(await notBuiltMessage(() => client.database('app').bucket('q').get('k')), undefined);
  await assert.rejects(client.database('app').bucket('q').get('k'), /GET is not supported on a fifo bucket/);
});

test('field list halves its page on RESULT_TOO_LARGE as often as it takes', async () => {
  const limits: number[] = [];
  let served = 0;
  const { client } = recordingClient(
    new Map([
      [
        'FIELD_LIST',
        ((request) => {
          const limit = Number(request.fields['limit']);
          limits.push(limit);
          if (limit > 30) throw new ResultTooLargeError({ message: 'result over the node ceiling', operation: 'list' });
          const entries = Array.from({ length: Math.min(limit, 100 - served) }, (_, index) => ({ element_key: `e${served + index}` }));
          served += entries.length;
          return { success: true, entries, has_more: served < 100 };
        }) as AnswerFrom,
      ],
    ]),
  );
  const entries = await client.database('app').hash('users').field('ada', 'Purchases').list({ pageSize: 100 }).toArray();
  assert.equal(entries.length, 100);
  assert.deepEqual(limits.slice(0, 4), [100, 50, 25, 25]);
});

test('field getBlob on a field that is not a blob store is refused', async () => {
  // A hash store field answers FIELD_GET with its element and no blob: there is no blob to return.
  const { client } = recordingClient(new Map([['FIELD_GET', { found: true, element: { Name: 'Ada' }, element_key: 'e1' }]]));
  await assert.rejects(client.database('app').hash('users').field('ada', 'Friends').getBlob('e1'), (error: Error & { code?: string }) => {
    assert.equal(error.code, 'INVALID_ARGUMENT');
    assert.equal(
      error.message,
      'field "Friends" of app/users/ada answered getBlob with no blob: it is not a blob store field. Read it with get(element), or call getBlob on a blobStore field.',
    );
    return true;
  });
});

test('insertMany whose later half is refused says how much was already written', async () => {
  const identity = makeTlsIdentity();
  let batches = 0;
  const server = await startFakeServer({
    identity,
    onFrame: (frame, conn) => {
      if (frame.opcode === Op.AUTH) {
        conn.replyDoc(Op.AUTH_OK, frame.requestId, authOkDoc());
        return;
      }
      if (frame.opcode !== Op.BATCH_PUT) return;
      batches += 1;
      // Four documents are refused whole; the first half is written; the second half is refused.
      if (batches === 1) conn.replyDoc(Op.BATCH_PUT_OK, frame.requestId, { success: false, message: 'the batch is too large to apply atomically; none of it was written' });
      else if (batches === 2) conn.replyDoc(Op.BATCH_PUT_OK, frame.requestId, { success: true, ids: ['a', 'b'], count: 2 });
      else conn.replyDoc(Op.BATCH_PUT_OK, frame.requestId, { success: false, message: 'duplicate key "c" on index by_email; nothing from the batch was written', write_outcome: 'not_applied' });
    },
  });
  const client = await connect(`hoarddb://admin:pw-SECRET-1@127.0.0.1:${server.port}`, {
    tls: { fingerprints: [identity.fingerprint], knownServersPath: false },
  });
  try {
    await assert.rejects(
      client.database('app').hash('users').insertMany([{ N: 1 }, { N: 2 }, { N: 3 }, { N: 4 }]),
      (error: HoardDBError) => {
        assert.equal(error.code, 'INVALID_ARGUMENT');
        assert.equal(error.writtenBefore, 2, 'the first half was written before the refusal');
        assert.equal(error.writeOutcome, 'unknown', 'the batch as a whole is partly written: never not_applied');
        assert.equal(error.retryable, false);
        // In order: what the server refused and why (without its "nothing from the batch was
        // written", which is true of the refused part only), what was written, what to do.
        assert.equal(
          error.message,
          'The server refused a later part of this batch, after its first 2 documents: duplicate key "c" on index by_email. ' +
            'The first 2 documents of the batch, in the order given, were written. ' +
            'Read the batch back before resending, and resend only the documents that are missing.',
        );
        assert.equal(error.toJSON().writtenBefore, 2);
        return true;
      },
    );
    assert.equal(batches, 3);
  } finally {
    await client.close();
    await server.close();
    removeTlsIdentity(identity);
  }
});

test('a million field-store handles do no I/O and stay under their bounds', () => {
  v8.setFlagsFromString('--expose-gc');
  const gc = vm.runInNewContext('gc') as () => void;
  const { client, sent } = recordingClient(new Map());
  const users = client.database('app').hash('users');
  const purchases = users.field('ada', 'Purchases');

  const measure = (make: (index: number) => unknown): number => {
    gc();
    const before = process.memoryUsage().heapUsed;
    const handles: unknown[] = [];
    for (let index = 0; index < 1_000_000; index += 1) handles.push(make(index));
    gc();
    const after = process.memoryUsage().heapUsed;
    assert.equal(handles.length, 1_000_000);
    return (after - before) / 1_000_000;
  };
  const field = measure((index) => users.field('k' + index, 'Purchases'));
  const nested = measure((index) => purchases.field('e' + index, 'Lines'));
  process.stdout.write(`field handle cost: ${Math.round(field)} bytes; nested: ${Math.round(nested)} bytes\n`);

  // A field store is a bucket reference, a key, a field name and its path (measured 130 bytes with its
  // key string); a nested one also holds a new path array of the outer field and element (measured
  // 282). A per-handle Promise (+87) or Map (+224) crosses either bound (build doc section 6).
  assert.ok(field < 170, `a field-store handle costs ${field} bytes`);
  assert.ok(nested < 330, `a nested field-store handle costs ${nested} bytes`);
  assert.equal(sent.length, 0, 'creating field-store handles sent a request');
});

test('a nested field store sends the path to its element', async () => {
  const { client, sent } = recordingClient(new Map([['FIELD_PUSH', { success: true, entry_id: 'e1' }]]));
  await client.database('app').hash('users').field('ada', 'Purchases').field('order-1', 'Lines').push({ Sku: 'x' });
  assert.equal(sent[0]?.fields['field'], 'Lines', 'the inner store is the field');
  assert.deepEqual(sent[0]?.fields['path'], ['Purchases', 'order-1'], 'the path names the outer field and its element');
  assert.equal(sent[0]?.fields['key'], 'ada');
});

test('insertMany with a write concern sends it on every half', async () => {
  let batches = 0;
  const { client, sent } = recordingClient(
    new Map([
      [
        'BATCH_PUT',
        () => {
          batches += 1;
          return batches === 1
            ? { success: false, message: 'the batch is too large to apply atomically; none of it was written' }
            : { success: true, ids: ['x'], count: 1 };
        },
      ],
    ]),
  );
  await client.database('app').hash('users').insertMany([{ N: 1 }, { N: 2 }], { writeConcern: 'majority' });
  assert.equal(sent.length, 3, 'the whole batch, then each half');
  // Sent by the driver's call path (src/call.ts), not added by this test's helper.
  for (const request of sent) assert.equal(request.fields['writeconcern'], 'majority');
});

test('a partly written batch refused by an ERROR frame reads as one account, not a contradiction', async () => {
  // The server stamps write_outcome not_applied on a duplicate-key refusal (the vector "duplicate key on a
  // unique index"). This fake models a server older than that stamp, which sends none, so call() adds the
  // unknown-outcome sentence; the batch's own account replaces it and the server's "so nothing from the
  // batch was written".
  const identity = makeTlsIdentity();
  let batches = 0;
  const server = await startFakeServer({
    identity,
    onFrame: (frame, conn) => {
      if (frame.opcode === Op.AUTH) {
        conn.replyDoc(Op.AUTH_OK, frame.requestId, authOkDoc());
        return;
      }
      if (frame.opcode !== Op.BATCH_PUT) return;
      batches += 1;
      if (batches === 1) conn.replyDoc(Op.BATCH_PUT_OK, frame.requestId, { success: false, message: 'the batch is too large to apply atomically; none of it was written' });
      else if (batches === 2) conn.replyDoc(Op.BATCH_PUT_OK, frame.requestId, { success: true, ids: ['a'], count: 1 });
      else conn.replyDoc(Op.ERROR, frame.requestId, { code: 0x0f, message: 'duplicate key "b" for unique index by_email; so nothing from the batch was written' });
    },
  });
  const client = await connect(`hoarddb://admin:pw-SECRET-1@127.0.0.1:${server.port}`, {
    tls: { fingerprints: [identity.fingerprint], knownServersPath: false },
  });
  try {
    await assert.rejects(client.database('app').hash('users').insertMany([{ N: 1 }, { N: 2 }]), (error: HoardDBError) => {
      assert.equal(error.code, 'DUPLICATE_KEY');
      assert.equal(error.writtenBefore, 1);
      assert.equal(
        error.message,
        'The server refused a later part of this batch, after its first 1 documents: duplicate key "b" for unique index by_email. ' +
          'The first 1 documents of the batch, in the order given, were written. ' +
          'Read the batch back before resending, and resend only the documents that are missing.',
      );
      return true;
    });
  } finally {
    await client.close();
    await server.close();
    removeTlsIdentity(identity);
  }
});

test("a partly written batch says the server's document number counts within the refused part", async () => {
  // The server's own sentence (store/unique.go DuplicateKeyError): its "document 2 of the batch" is the
  // second document of the part the driver sent, which after halving is not the caller's second.
  const serverMessage =
    'Duplicate value for unique index "by_email" on bucket "users": "a@x" is already used by document "u1". ' +
    'Change the value, update that document instead, or delete it first. ' +
    'Document "u4", document 2 of the batch, was refused, so nothing from the batch was written: re-send the batch without it.';
  const identity = makeTlsIdentity();
  let batches = 0;
  const server = await startFakeServer({
    identity,
    onFrame: (frame, conn) => {
      if (frame.opcode === Op.AUTH) {
        conn.replyDoc(Op.AUTH_OK, frame.requestId, authOkDoc());
        return;
      }
      if (frame.opcode !== Op.BATCH_PUT) return;
      batches += 1;
      if (batches === 1) conn.replyDoc(Op.BATCH_PUT_OK, frame.requestId, { success: false, message: 'the batch is too large to apply atomically; none of it was written' });
      else if (batches === 2) conn.replyDoc(Op.BATCH_PUT_OK, frame.requestId, { success: true, ids: ['u1', 'u2'], count: 2 });
      else conn.replyDoc(Op.ERROR, frame.requestId, { code: 0x0f, message: serverMessage });
    },
  });
  const client = await connect(`hoarddb://admin:pw-SECRET-1@127.0.0.1:${server.port}`, {
    tls: { fingerprints: [identity.fingerprint], knownServersPath: false },
  });
  try {
    const docs = [1, 2, 3, 4].map((n) => ({ _id_: `u${n}`, Email: n === 4 ? 'a@x' : `${n}@x` }));
    await assert.rejects(client.database('app').hash('users').insertMany(docs), (error: HoardDBError) => {
      assert.equal(error.code, 'DUPLICATE_KEY');
      assert.equal(error.writtenBefore, 2);
      assert.equal(
        error.message,
        'The server refused a later part of this batch, after its first 2 documents: ' +
          'Duplicate value for unique index "by_email" on bucket "users": "a@x" is already used by document "u1". ' +
          'Change the value, update that document instead, or delete it first. ' +
          'Document "u4", document 2 of the batch, was refused: re-send the batch without it. ' +
          "The server's document numbers count within the refused part, which begins at document 3 of this batch. " +
          'The first 2 documents of the batch, in the order given, were written. ' +
          'Read the batch back before resending, and resend only the documents that are missing.',
      );
      return true;
    });
  } finally {
    await client.close();
    await server.close();
    removeTlsIdentity(identity);
  }
});

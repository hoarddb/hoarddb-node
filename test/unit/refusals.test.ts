// SPDX-License-Identifier: Apache-2.0
//
// poolStats().errors counts every refusal a program sees, exactly once, whoever raised it: the server
// in an ERROR frame (step 10), the server in band (success or found false), or the driver itself
// before anything was sent. A refusal a verb swallows on purpose (createDatabase with ifNotExists) is
// not one the program saw. Build doc steps 11 to 14; the counter is one helper on every public
// method, so a later verb cannot forget it.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { BucketHandle } from '../../src/bucket.js';
import { ClientImpl } from '../../src/client-core.js';
import { DatabaseHandle } from '../../src/database.js';
import { ResultTooLargeError, type HoardDBError } from '../../src/errors.js';
import { FieldStoreHandle } from '../../src/field-store.js';
import { countsRefusals } from '../../src/refusals.js';
import type { OpName } from '../../src/wire/opcodes.js';
import { recordingClient, type AnswerFrom } from '../helpers/recording.js';

const ADA = { Name: 'Ada' };

/** Runs a call that must be refused, and returns the refusal. */
async function refusal(run: () => unknown): Promise<HoardDBError> {
  try {
    await run();
  } catch (error) {
    return error as HoardDBError;
  }
  throw new Error('the call was expected to be refused');
}

function answers(entries: [OpName, Record<string, unknown>][]): Map<OpName, Record<string, unknown>> {
  return new Map(entries);
}

test('every in-band refusal of a keyed, queue or batch verb is counted once', async () => {
  const { client, stats } = recordingClient(
    answers([
      ['GET', { found: false, message: 'GET is not supported on a fifo bucket' }],
      ['FIFO_POP', { found: false, message: 'pop is not supported on a hash bucket' }],
      ['FIFO_PEEK', { found: false, message: 'peek is not supported on a hash bucket' }],
      ['DELETE', { success: false, message: 'DELETE is not supported on a fifo bucket' }],
      ['BATCH_PUT', { success: false, message: 'the batch is too large to apply atomically; none of it was written' }],
      ['FIELD_PUT', { success: false, message: 'field "Purchases" is a fifo store; put is not one of its verbs' }],
    ]),
  );
  const db = client.database('app');

  await refusal(() => db.bucket('q').get('ada'));
  await refusal(() => db.bucket('users').pop());
  await refusal(() => db.bucket('users').peek());
  await refusal(() => db.bucket('q').delete('ada'));
  // Halved down to one document, whose refusal is the caller's: one refusal, not one per half.
  await refusal(() => db.hash('users').insertMany([ADA, ADA, ADA, ADA]));
  await refusal(() => db.hash('users').field('ada', 'Purchases').put('x', ADA));

  assert.deepEqual(stats.errors, { INVALID_ARGUMENT: 6 });
});

test('insertMany of nothing is counted once', async () => {
  const { client, stats } = recordingClient(answers([['BATCH_PUT', { success: false, message: 'no documents to write' }]]));
  const error = await refusal(() => client.database('app').hash('users').insertMany([]));
  assert.equal(error.code, 'INVALID_ARGUMENT');
  assert.deepEqual(stats.errors, { INVALID_ARGUMENT: 1 });
});

test('a refusal raised inside a cursor page is counted once', async () => {
  const { client, stats } = recordingClient(
    answers([
      ['SCAN', { found: false, message: 'bucket "nobody" not found in database "app"' }],
      ['FIELD_LIST', { success: false, message: 'field "Purchases" is not declared' }],
    ]),
  );
  const db = client.database('app');

  const missing = await refusal(() => db.hash('nobody').find({}).toArray());
  assert.equal(missing.code, 'NOT_FOUND');
  await refusal(() => db.hash('users').field('ada', 'Purchases').list().toArray());

  assert.deepEqual(stats.errors, { NOT_FOUND: 1, INVALID_ARGUMENT: 1 });
});

test('DDL refusals are counted once, and one swallowed by ifNotExists not at all', async () => {
  const refused = recordingClient(answers([['CREATE_BUCKET', { success: false, message: 'bucket name "a b" is not valid' }]]));
  await refusal(() => refused.client.database('app').createBucket('a b', 'hash'));
  assert.deepEqual(refused.stats.errors, { INVALID_ARGUMENT: 1 });

  const sameType = recordingClient(
    answers([['CREATE_BUCKET', { success: true, message: 'bucket "users" already exists (type: hash)' }]]),
  );
  const db = sameType.client.database('app');
  const exists = await refusal(() => db.createBucket('users', 'hash'));
  assert.equal(exists.code, 'ALREADY_EXISTS');
  await db.createBucket('users', 'hash', { ifNotExists: true });
  assert.deepEqual(sameType.stats.errors, { ALREADY_EXISTS: 1 });
});

test('refusals the driver raises before sending are counted once', async () => {
  const { client, stats, sent } = recordingClient(new Map(), 'hoarddb://admin@localhost:7433/app', []);
  const db = client.database('app');

  await refusal(() => db.fifo('q').peek({ limit: 0 }));
  await refusal(() => db.heap('h').push(ADA, { priority: 1.5 }));
  await refusal(() => db.hash('users').get('ada', { consistent: true }));
  await refusal(() => db.createBucket('users', 'hash', { replicationFactor: 2 }));
  await refusal(() => db.hash<{ Name: string; Born: number }>('users').find({}, { sort: { Name: 1, Born: -1 } }));
  await refusal(() => db.bucket('users').update('ada', {}));

  assert.deepEqual(stats.errors, { INVALID_ARGUMENT: 4, UNSUPPORTED_FEATURE: 2 });
  assert.equal(sent.length, 0, 'none of them was sent');
});

test('every public method of the client and of each handle counts its refusals', () => {
  // The two internals the handles call on the client are left alone: a refusal through them is
  // counted where it leaves the public verb that called them. Everything else on a prototype is
  // public (helpers are ES private methods), so a verb added later is counted without remembering to.
  const shared: Record<string, readonly string[]> = { ClientImpl: ['send', 'requireCapability'] };
  for (const type of [ClientImpl, DatabaseHandle, BucketHandle, FieldStoreHandle]) {
    const prototype = type.prototype as unknown as Record<string, unknown>;
    let methods = 0;
    for (const name of Object.getOwnPropertyNames(prototype)) {
      const value = Object.getOwnPropertyDescriptor(prototype, name)?.value as unknown;
      if (name === 'constructor' || typeof value !== 'function') continue;
      const expected = !(shared[type.name] ?? []).includes(name);
      assert.equal(countsRefusals(value), expected, `${type.name}.${name} ${expected ? 'does not count' : 'counts'} refusals`);
      methods += 1;
    }
    assert.ok(methods > 3, `${type.name} has public methods`);
  }
});

test('a RESULT_TOO_LARGE a cursor recovers from by halving is not counted; one it throws is, once', async () => {
  // The server's ceiling holds one item per page: a cursor asked for 4 halves to 2, then to 1, and
  // reads on. Those refusals never reach the caller, so they are not refusals the program saw.
  const tooLarge = (): never => {
    throw new ResultTooLargeError({ message: 'result over the node ceiling', operation: 'scan', maxResultBytes: 16, retainedBytes: 32 });
  };
  const served = { SCAN: 0, BTREE_RANGE: 0, FIELD_LIST: 0 };
  const keys = ['a', 'b', 'c'];
  const { client, stats } = recordingClient(
    new Map<OpName, Record<string, unknown> | AnswerFrom>([
      [
        'SCAN',
        (request) => {
          if (Number(request.fields['limit']) > 1) tooLarge();
          served.SCAN += 1;
          return { found: true, documents: [{ _id_: `d${served.SCAN}` }], has_more: served.SCAN < 3, total: 3 };
        },
      ],
      [
        'BTREE_RANGE',
        (request) => {
          const first = request.fields['low'] === 'a' && served.BTREE_RANGE === 0;
          if (Number(request.fields['limit']) > (first ? 1 : 2)) tooLarge();
          served.BTREE_RANGE += 1;
          const from = keys.indexOf(String(request.fields['low']));
          return { entries: keys.slice(from, from + Number(request.fields['limit'])).map((key) => ({ key, data: {} })) };
        },
      ],
      [
        'FIELD_LIST',
        (request) => {
          if (Number(request.fields['limit']) > 1) tooLarge();
          served.FIELD_LIST += 1;
          return { success: true, entries: [{ element_key: `e${served.FIELD_LIST}` }], has_more: served.FIELD_LIST < 3 };
        },
      ],
    ]),
  );
  const db = client.database('app');

  assert.equal((await db.hash('users').find({}, { pageSize: 4 }).toArray()).length, 3);
  assert.equal((await db.btree('t').range({ gte: 'a' }, { pageSize: 4 }).toArray()).length, 3);
  assert.equal((await db.hash('users').field('ada', 'Purchases').list({ pageSize: 4 }).toArray()).length, 3);
  assert.deepEqual(stats.errors, {}, 'every RESULT_TOO_LARGE was recovered from by halving');

  // A page that cannot fit even one item: the cursor throws, and that one refusal is counted once.
  const never = recordingClient(new Map<OpName, Record<string, unknown> | AnswerFrom>([['SCAN', () => tooLarge()]]));
  await refusal(() => never.client.database('app').hash('users').find({}, { pageSize: 4 }).toArray());
  assert.deepEqual(never.stats.errors, { RESULT_TOO_LARGE: 1 });
});

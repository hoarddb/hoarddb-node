// SPDX-License-Identifier: Apache-2.0
//
// update with all nine operators (build doc section 3.9, step 20a), checked against the frozen vectors:
// each call is made on a recording client and the request must match the vector's request; the result
// is read from the vector's own answer. The local refusals are proved to send nothing, with their exact
// texts, and the number types ($inc int64, $mul double) are proved on the bytes.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { asDouble } from '../../src/codec/values.js';
import { encodeDocument, extendedJsonFromBytes, valuesFromExtendedJson } from '../../src/codec/index.js';
import { InvalidArgumentError, NotFoundError } from '../../src/errors.js';
import type { Doc, HashBucket, UpdateOps } from '../../src/types.js';
import { answerTo, assertSentAs, recordingClient } from '../helpers/recording.js';
import { vectorNamed } from '../helpers/vectors.js';

/** The database a vector's own request names: the call is made in it, as the vector was captured. */
function databaseOf(name: string): string {
  return (vectorNamed(name)['request'] as { payload_json: { database: string } }).payload_json.database;
}

/** The document a vector's answer carries, as the driver reads it. */
function answerDocOf(name: string): unknown {
  const response = vectorNamed(name)['response'] as { payload_json: Record<string, unknown> };
  return valuesFromExtendedJson(response.payload_json, 'safe')['doc'];
}

/** One call against one vector: the request matches, and the resolved value is returned for the caller to compare. */
async function checkVector(name: string, call: (users: HashBucket<Doc>) => Promise<unknown>): Promise<unknown> {
  const vector = vectorNamed(name);
  const { client, sent } = recordingClient(answerTo(vector));
  const resolved = await call(client.database(databaseOf(name)).hash('users'));
  assertSentAs(sent[0], vector);
  return resolved;
}

test('update with set, unset and inc', async () => {
  const name = 'update with set, unset and inc';
  const resolved = await checkVector(name, (users) =>
    users.update('ada', { $set: { 'Address.City': 'London' }, $unset: ['Draft'], $inc: { Visits: 2 } }),
  );
  assert.deepStrictEqual(resolved, answerDocOf(name));
  assert.equal((resolved as { Visits: number }).Visits, 3);
});

test('update with push', async () => {
  const name = 'update with push';
  const resolved = await checkVector(name, (users) => users.update('ada', { $push: { Tags: 'poetry', Langs: 'en' } }));
  assert.deepStrictEqual(resolved, answerDocOf(name));
});

test('update with addtoset sends the one-word wire name', async () => {
  const name = 'update with addtoset';
  const vector = vectorNamed(name);
  const { client, sent } = recordingClient(answerTo(vector));
  const resolved = await client.database(databaseOf(name)).hash('users').update('ada', { $addToSet: { Tags: 'poetry' } });
  assertSentAs(sent[0], vector);
  assert.deepStrictEqual(resolved, answerDocOf(name));
  const fields = Object.keys(sent[0]?.fields ?? {});
  assert.ok(fields.includes('addtoset'), 'the wire name is addtoset');
  assert.ok(!fields.includes('addToSet') && !fields.includes('add_to_set'), 'no guessed spelling');
});

test('update with mul sends doubles', async () => {
  const name = 'update with mul';
  const vector = vectorNamed(name);
  const { client, sent } = recordingClient(answerTo(vector));
  const bucket = client.database(databaseOf(name)).hash('users');
  const resolved = await bucket.update('ada', { $mul: { Score: 1.5, Missing: 0.5 } });
  assertSentAs(sent[0], vector);
  assert.deepStrictEqual(resolved, answerDocOf(name));

  await bucket.update('ada', { $mul: { Score: 2 } });
  const mul = extendedJsonFromBytes((sent[1] as { bytes: Uint8Array }).bytes)['mul'] as { Score: unknown };
  assert.deepStrictEqual(mul.Score, { $numberDouble: '2.0' });
});

test('update with min and max', async () => {
  const name = 'update with min and max';
  const resolved = await checkVector(name, (users) =>
    users.update('ada', { $min: { Age: 30, Floor: 5 }, $max: { Best: 99 } }),
  );
  assert.deepStrictEqual(resolved, answerDocOf(name));
});

test('update with rename, and onto a field that exists', async () => {
  const first = 'update with rename';
  const resolved = await checkVector(first, (users) =>
    users.update('ada', { $rename: { Nick: 'Handle', 'Address.Zip': 'Address.PostCode' } }),
  );
  assert.deepStrictEqual(resolved, answerDocOf(first));

  const second = 'update with rename onto a field that exists does nothing';
  const again = await checkVector(second, (users) => users.update('ada', { $rename: { Nick: 'Handle' } }));
  assert.deepStrictEqual(again, answerDocOf(second));
});

test('update with every operator', async () => {
  const name = 'update with every operator';
  const vector = vectorNamed(name);
  const { client, sent } = recordingClient(answerTo(vector));
  const resolved = await client.database(databaseOf(name)).hash('users').update('ada', {
    $set: { City: 'London' },
    $unset: ['Draft'],
    $inc: { Visits: 2 },
    $push: { Tags: 'poetry' },
    $addToSet: { Langs: 'en' },
    $mul: { Score: 1.5 },
    $min: { Age: 30 },
    $max: { Best: 99 },
    $rename: { Nick: 'Handle' },
  });
  assertSentAs(sent[0], vector);
  assert.deepStrictEqual(resolved, answerDocOf(name));
  assert.deepStrictEqual(
    Object.keys(sent[0]?.fields ?? {}).sort(),
    ['database', 'bucket', 'key', 'set', 'unset', 'inc', 'push', 'addtoset', 'mul', 'min', 'max', 'rename'].sort(),
  );
});

test('update of a missing key throws NotFoundError', async () => {
  const name = 'update of a key that does not exist';
  await assert.rejects(checkVector(name, (users) => users.update('nobody', { $set: { Name: 'Nobody' } })), NotFoundError);
});

test('refused updates are sent as the vectors send them', async () => {
  // The real answer is an ERROR frame, proved on a server in this step; here only what is sent is checked.
  const cases: [string, UpdateOps<Doc>][] = [
    ['update with a bad operand', { $inc: { Name: 1 } }],
    ['update with mul on a string is refused', { $mul: { Name: 1.5 } }],
    ['update with inc past the 64-bit range is refused', { $inc: { Visits: 1 } }],
    ['update with unset of an array position is refused', { $unset: ['Tags[0]'] }],
  ];
  for (const [name, ops] of cases) {
    const vector = vectorNamed(name);
    const { client, sent } = recordingClient(new Map([['UPDATE', { success: true }]]));
    await client.database(databaseOf(name)).hash('users').update('ada', ops);
    assertSentAs(sent[0], vector);
  }
});

test('local refusals send nothing', async () => {
  const OPERATORS = '$set, $unset, $inc, $push, $addToSet, $mul, $min, $max, $rename';
  const EMPTY = `update needs at least one operator with at least one field, from ${OPERATORS}: for example {$set: {field: value}}`;
  const cases: [unknown, string][] = [
    [{}, EMPTY],
    [{ $set: {}, $unset: [] }, EMPTY],
    ['x', 'update needs an operator document, for example {$set: {field: value}}'],
    [{ $pull: { Tags: 'x' } }, `$pull is not supported — supported update operators: ${OPERATORS}`],
    [{ $unset: { City: '' } }, '$unset needs a list of field names: {$unset: ["a", "b"]}'],
    [{ $push: ['Tags'] }, '$push needs a document: {$push: {field: value}}'],
    [
      { $inc: { Age: 1.5 } },
      '$inc on "Age" needs a whole number that fits in 64 bits, got 1.5: write a whole number, or $set the new value: {$set: {Age: <value>}}',
    ],
    [
      { $inc: { Age: 2n ** 63n } },
      '$inc on "Age" needs a whole number that fits in 64 bits, got 9223372036854775808n: write a whole number, or $set the new value: {$set: {Age: <value>}}',
    ],
    [
      { $mul: { Score: 'two' } },
      '$mul on "Score" needs a finite number, got "two": write a number, or $set the new value: {$set: {Score: <value>}}',
    ],
    [
      { $mul: { Score: Number.NaN } },
      '$mul on "Score" needs a finite number, got NaN: write a number, or $set the new value: {$set: {Score: <value>}}',
    ],
    [
      { $rename: { Handle: 5 } },
      '$rename of "Handle" needs the new name as a string, got 5: write {$rename: {oldName: "newName"}}',
    ],
  ];
  const { client, sent } = recordingClient(new Map());
  const bucket = client.database('app').hash('users');
  for (const [ops, message] of cases) {
    await assert.rejects(
      bucket.update('ada', ops as unknown as UpdateOps<Doc>),
      (error: unknown) => {
        assert.ok(error instanceof InvalidArgumentError, `an InvalidArgumentError for ${message}`);
        assert.equal(error.wireCode, null);
        assert.equal(error.message, message);
        return true;
      },
    );
  }
  assert.equal(sent.length, 0, 'nothing was sent');
});

test('$inc sends int64 for a number, a whole double and a bigint', async () => {
  const { client, sent } = recordingClient(new Map([['UPDATE', { success: true }]]));
  await client.database('app').hash('users').update('ada', { $inc: { A: 2, B: -3n, C: 4.0 } });
  const inc = extendedJsonFromBytes((sent[0] as { bytes: Uint8Array }).bytes)['inc'];
  assert.deepStrictEqual(inc, { A: { $numberLong: '2' }, B: { $numberLong: '-3' }, C: { $numberLong: '4' } });
});

test('only the operators given are sent, never filter or multi', async () => {
  const { client, sent } = recordingClient(new Map([['UPDATE', { success: true }]]));
  const bucket = client.database('app').hash('users');
  await bucket.update('ada', { $set: { a: 1 }, $push: undefined });
  assert.deepStrictEqual(Object.keys(sent[0]?.fields ?? {}).sort(), ['bucket', 'database', 'key', 'set']);

  await bucket.update('ada', { $set: { a: 1 } }, { writeConcern: 'majority' });
  assert.deepStrictEqual(Object.keys(sent[1]?.fields ?? {}).sort(), ['bucket', 'database', 'key', 'set', 'writeconcern']);
});

test('asDouble writes a double and a look-alike does not', () => {
  assert.deepStrictEqual(extendedJsonFromBytes(encodeDocument({ x: asDouble(2) })), { x: { $numberDouble: '2.0' } });
  assert.deepStrictEqual(extendedJsonFromBytes(encodeDocument({ x: { double: 2 } })), { x: { double: { $numberInt: '2' } } });
});

test('no verb is left unbuilt, update included', async () => {
  const { client } = recordingClient(new Map([['UPDATE', { success: true, doc: { a: 1 } }]]));
  const resolved = await client.database('app').hash('users').update('ada', { $set: { a: 1 } });
  assert.ok(resolved !== undefined, 'update answered');
  // The unbuilt stub failed with a sentence ending "is not built yet"; the built verb never does.
  assert.deepStrictEqual(resolved, { a: 1 });
});

test('a value hoardDB cannot store inside an operator is refused not_applied, nothing sent', async () => {
  // The value check runs in the encode step (toWire), after updateFields: it is still a write refused
  // before sending, so section 5.2's not_applied applies to it as to every other local update refusal.
  const { client, sent, stats } = recordingClient(new Map([['UPDATE', { success: true, doc: {} }]]));
  const users = client.database('app').hash('users');
  await assert.rejects(users.update('ada', { $set: { m: new Map() } } as unknown as UpdateOps<Doc>), (error: InvalidArgumentError) => {
    assert.ok(error instanceof InvalidArgumentError);
    assert.equal(error.writeOutcome, 'not_applied');
    assert.match(error.message, /^field "set\.m" holds a Map; hoardDB stores /);
    return true;
  });
  assert.equal(sent.length, 0);
  assert.deepEqual(stats.errors, { INVALID_ARGUMENT: 1 });
});

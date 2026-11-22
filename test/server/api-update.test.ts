// SPDX-License-Identifier: Apache-2.0
//
// update with all nine operators against a real server (build doc section 3.9, step 20a): the document
// each operator leaves, the quiet corners, the server's own refusals word for word, and the rule that
// an update is all or nothing. One server serves the file; every test works on its own keys.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { InvalidArgumentError, connect, type Client, type Doc, type HashBucket } from '../../src/index.js';
import { valuesFromExtendedJson } from '../../src/codec/index.js';
import { startServer, type TestServer } from '../helpers/server.js';
import { vectorNamed } from '../helpers/vectors.js';
import { NotFoundError } from '../../src/errors.js';

const DATABASE = 'node_update';

let server: TestServer;
let client: Client;
let users: HashBucket<Doc>;

before(async () => {
  server = await startServer();
  client = await connect(server.uri(), { tls: { knownServersPath: false } });
  await client.createDatabase(DATABASE);
  users = await client.database(DATABASE).createBucket('users', 'hash');
});

after(async () => {
  await client?.close({ timeoutMs: 1_000 });
  await server?.stop();
});

interface UpdateVector {
  setup: { opcode_name: string; payload_json: { data: unknown } }[];
  request: { payload_json: { database: string } };
  response: { payload_json: { message: string } };
}

/** Put the vector's setup document under `key`, as JavaScript values, and return the vector. */
async function putSetupOf(name: string, key: string): Promise<UpdateVector> {
  const vector = vectorNamed(name) as unknown as UpdateVector;
  const put = vector.setup.find((step) => step.opcode_name === 'PUT');
  assert.ok(put !== undefined, `${name} has a setup document`);
  await users.put(key, valuesFromExtendedJson(put.payload_json.data as Record<string, unknown>, 'safe'));
  return vector;
}

/** The vector's server message, with its database name replaced by this file's. */
function messageOf(vector: UpdateVector): string {
  return vector.response.payload_json.message.replaceAll(vector.request.payload_json.database, DATABASE);
}

/** The vector's message, verbatim: a refused update carries write_outcome not_applied, so the driver adds nothing. */
function assertServerMessage(actual: string, expected: string, label: string): void {
  assert.equal(actual, expected, `${label}: the server's message, verbatim`);
}

async function refusalOf(call: () => Promise<unknown>): Promise<InvalidArgumentError> {
  try {
    await call();
  } catch (error) {
    assert.ok(error instanceof InvalidArgumentError, `an InvalidArgumentError, got ${String(error)}`);
    assert.equal(error.writeOutcome, 'not_applied', 'a refused update says nothing was applied');
    return error;
  }
  throw new Error('the update resolved; the server should have refused it');
}

test('every operator changes the document as the vector says', async () => {
  await putSetupOf('update with every operator', 'ada');
  const expected = {
    Age: 30,
    Best: 99,
    City: 'London',
    Handle: 'gh',
    Langs: ['en'],
    Name: 'Ada',
    Score: 15,
    Tags: ['maths', 'poetry'],
    Visits: 3,
    _id_: 'ada',
  };
  const updated = await users.update('ada', {
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
  assert.deepStrictEqual(updated, expected);
  assert.deepStrictEqual(await users.get('ada'), expected);
});

test('a missing key throws NotFoundError', async () => {
  await assert.rejects(users.update('nobody', { $set: { a: 1 } }), NotFoundError);
});

test('the quiet corners answer as section 3.9 says', async () => {
  await users.put('grace', { Tags: ['new'], Nick: 'gh', Handle: 'old', Label: 'x' });

  const pushed = await users.update('grace', { $push: { Tags: 'new' }, $addToSet: { Tags: 'new' } });
  assert.deepStrictEqual(pushed?.['Tags'], ['new', 'new'], 'push appends a duplicate; addToSet then adds nothing');

  const multiplied = await users.update('grace', { $mul: { Missing: 2 } });
  assert.ok(multiplied !== null && !('Missing' in multiplied), 'an absent field is skipped by $mul');

  const bounded = await users.update('grace', { $min: { Low: 5 }, $max: { High: 7 } });
  assert.equal(bounded?.['Low'], 5);
  assert.equal(bounded?.['High'], 7);

  const mismatched = await users.update('grace', { $min: { Label: 1 } });
  assert.equal(mismatched?.['Label'], 'x', 'a value that does not compare is left as it is');

  const renamed = await users.update('grace', { $rename: { Nick: 'Handle' } });
  assert.equal(renamed?.['Nick'], 'gh');
  assert.equal(renamed?.['Handle'], 'old', 'a rename onto an existing field does nothing');
});

test('$inc and $mul refuse a field that is not a number, word for word', async () => {
  const incVector = await putSetupOf('update with a bad operand', 'ada');
  const before = await users.get('ada');

  const incRefusal = await refusalOf(() => users.update('ada', { $inc: { Name: 1 } }));
  assert.equal(incRefusal.wireCode, 4);
  assertServerMessage(incRefusal.message, messageOf(incVector), '$inc');

  const mulVector = vectorNamed('update with mul on a string is refused') as unknown as UpdateVector;
  const mulRefusal = await refusalOf(() => users.update('ada', { $mul: { Name: 1.5 } }));
  assert.equal(mulRefusal.wireCode, 4);
  assertServerMessage(mulRefusal.message, messageOf(mulVector), '$mul');

  assert.deepStrictEqual(await users.get('ada'), before, 'the document is unchanged');
});

test('an update is all or nothing', async () => {
  await putSetupOf('update with a bad operand', 'ada');
  await refusalOf(() => users.update('ada', { $set: { City: 'Paris' }, $inc: { Name: 1 } }));
  const stored = await users.get('ada');
  assert.ok(stored !== null && !('City' in stored), 'the $set was not written');
});

test('an int64 overflow is refused, not wrapped', async () => {
  const vector = await putSetupOf('update with inc past the 64-bit range is refused', 'ada');
  const incRefusal = await refusalOf(() => users.update('ada', { $inc: { Visits: 1 } }));
  assertServerMessage(incRefusal.message, messageOf(vector), '$inc overflow');

  const mulRefusal = await refusalOf(() => users.update('ada', { $mul: { Visits: 2 } }));
  assert.ok(mulRefusal.message.includes('would overflow int64'), mulRefusal.message);
  assert.ok(mulRefusal.message.includes("the product is outside int64's range"), mulRefusal.message);

  assert.equal((await users.get('ada'))?.['Visits'], 9223372036854775807n);
});

test('path refusals carry constraintRefusal', async () => {
  const vector = await putSetupOf('update with unset of an array position is refused', 'ada');
  const unsetRefusal = await refusalOf(() => users.update('ada', { $unset: ['Tags[0]'] }));
  assert.equal(unsetRefusal.constraintRefusal, true);
  assertServerMessage(unsetRefusal.message, messageOf(vector), '$unset array position');

  const renameRefusal = await refusalOf(() => users.update('ada', { $rename: { 'Tags[0]': 'First' } }));
  assert.equal(renameRefusal.constraintRefusal, true);
  assert.ok(renameRefusal.message.includes('an array position is not a name'), renameRefusal.message);
});

test('paths reach into sub-documents and arrays', async () => {
  await users.put('o1', { Address: { City: 'Tirana' }, Lines: [{ Qty: 1 }] });
  const updated = await users.update('o1', { $set: { 'Address.City': 'London' }, $inc: { 'Lines[0].Qty': 2 } });
  assert.equal((updated?.['Address'] as { City: string }).City, 'London');
  assert.equal((updated?.['Lines'] as { Qty: number }[])[0]?.Qty, 3);
});

test('$inc keeps integers as integers and doubles as doubles', async () => {
  await users.put('n', { I: 1, D: 2.5 });
  const updated = await users.update('n', { $inc: { I: 2, D: 1 } });
  assert.equal(updated?.['I'], 3);
  assert.equal(updated?.['D'], 3.5);
});

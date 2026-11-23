// SPDX-License-Identifier: Apache-2.0
//
// put and insert never replace: a key that already holds a document is refused with wire code 0x12,
// DOCUMENT_EXISTS, and nothing is written. The answers are the server's own bytes, from the
// frozen vectors.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { isHoardDBError, type HoardDBError } from '../../src/errors.js';
import { answerTo, assertSentAs, recordingClient } from '../helpers/recording.js';
import { vectorNamed, type Vector } from '../helpers/vectors.js';

interface Recorded extends Vector {
  response: { opcode_name: string; payload_hex: string };
}

function recorded(name: string): Recorded {
  return vectorNamed(name) as Recorded;
}

function assertDocumentExists(error: unknown, operation: string): HoardDBError {
  assert.ok(isHoardDBError(error), `${operation}: a driver error, got ${String(error)}`);
  assert.equal(error.name, 'DocumentExistsError', operation);
  assert.equal(error.code, 'DOCUMENT_EXISTS', operation);
  assert.equal(error.wireCode, 0x12, operation);
  assert.equal(error.writeOutcome, 'not_applied', `${operation}: nothing was written`);
  assert.equal(error.retryable, false, `${operation}: the same request is refused again`);
  assert.equal(error.operation, operation);
  assert.match(error.hint ?? '', /upsert\(key, doc\)/, `${operation}: the hint names the verb that replaces`);
  return error;
}

test('put of a key that holds a document throws DocumentExistsError', async () => {
  const row = recorded('insert of an existing id is refused');
  const { client, sent } = recordingClient(answerTo(row));
  const users = client.database('v297').hash('users');
  await assert.rejects(users.put('ada', { Name: 'Ada Lovelace' }), (error: unknown) => {
    assert.equal(assertDocumentExists(error, 'put').target, 'v297/users/ada');
    return true;
  });
  assertSentAs(sent[0], row);
  assert.equal(sent.length, 1, 'the refused put is sent once');
});

test('put on a btree bucket is refused the same way (the server names BTREE_INSERT, the driver sends PUT)', async () => {
  const row = recorded('btree insert of an existing key is refused');
  const answer = [...answerTo(row).values()][0] ?? {};
  const { client } = recordingClient(new Map([['PUT' as const, answer]]));
  await assert.rejects(client.database('v299').btree('b').put('ada', { Name: 'Ada Lovelace' }), (error: unknown) => {
    assertDocumentExists(error, 'put');
    return true;
  });
});

test('insertMany naming a key that holds a document is refused whole with DocumentExistsError', async () => {
  const row = recorded('insert many naming an existing id is refused whole');
  const { client, sent } = recordingClient(answerTo(row));
  const users = client.database('v298').hash('users');
  await assert.rejects(
    users.insertMany([
      { Name: 'Grace', _id_: 'grace' },
      { Name: 'Ada Lovelace', _id_: 'ada' },
    ]),
    (error: unknown) => {
      assertDocumentExists(error, 'insertMany');
      return true;
    },
  );
  assertSentAs(sent[0], row);
  assert.equal(sent.length, 1, 'a batch refused for a held key is never halved and resent');
});

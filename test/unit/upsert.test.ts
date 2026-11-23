// SPDX-License-Identifier: Apache-2.0
//
// upsert(key, doc): UPSERT (0x16), answered by UPSERT_OK (0x17). It carries PUT's members and replaces
// the document a key holds instead of refusing it. Each request must match the shared vector's bytes
// and each result is read from the vector's own answer.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { InvalidArgumentError } from '../../src/errors.js';
import { encodeRequest } from '../../src/wire/messages.js';
import { Op, SUCCESS_REPLY } from '../../src/wire/opcodes.js';
import { answerTo, assertSentAs, recordingClient } from '../helpers/recording.js';
import { vectorNamed, type Vector } from '../helpers/vectors.js';

interface Recorded extends Vector {
  request: { opcode: number; payload_hex: string };
  response: { opcode: number };
}

function recorded(name: string): Recorded {
  return vectorNamed(name) as Recorded;
}

test('UPSERT is 0x16 and is answered by UPSERT_OK, 0x17, as the vectors record', () => {
  const row = recorded('upsert of an existing id on a hash bucket replaces it');
  assert.equal(Op.UPSERT, row.request.opcode);
  assert.equal(Op.UPSERT_OK, row.response.opcode);
  assert.deepEqual(SUCCESS_REPLY['UPSERT'], [Op.UPSERT_OK]);
  assert.equal(SUCCESS_REPLY['UPSERT_OK'], undefined, 'UPSERT_OK is an answer; a driver never sends it');
});

test('the UPSERT request is the vector, byte for byte', () => {
  const row = recorded('upsert of an existing id on a hash bucket replaces it');
  const bytes = encodeRequest('UPSERT', {
    database: 'v281',
    bucket: 'users',
    key: 'ada',
    data: { Born: 1815, Name: 'Ada Lovelace' },
    writeconcern: '',
  });
  assert.equal(Buffer.from(bytes).toString('hex'), row.request.payload_hex);
});

test('upsert on a hash bucket stores a new key and replaces a held one', async () => {
  for (const [name, database, doc] of [
    ['upsert of a new id on a hash bucket', 'v280', { Born: 1815, Name: 'Ada' }],
    ['upsert of an existing id on a hash bucket replaces it', 'v281', { Born: 1815, Name: 'Ada Lovelace' }],
  ] as const) {
    const row = recorded(name);
    const { client, sent } = recordingClient(answerTo(row));
    const written = await client.database(database).hash('users').upsert('ada', doc);
    assertSentAs(sent[0], row);
    assert.equal(written.id, 'ada', name);
  }
});

test('upsert on a btree bucket and on an untyped handle sends the same request', async () => {
  const row = recorded('upsert of an existing key on a btree bucket replaces it');
  for (const handle of ['btree', 'bucket'] as const) {
    const { client, sent } = recordingClient(answerTo(row));
    const written = await client.database('v283')[handle]('b').upsert('ada', { Name: 'Ada Lovelace' });
    assertSentAs(sent[0], row);
    assert.equal(written.id, 'ada', handle);
  }
});

test('upsert carries the write concern of the call', async () => {
  const row = recorded('upsert of a new id on a hash bucket');
  const { client, sent } = recordingClient(answerTo(row));
  await client.database('v280').hash('users').upsert('ada', { Name: 'Ada' }, { writeConcern: 'majority' });
  assert.equal(sent[0]?.fields['writeconcern'], 'majority');
});

test('upsert with an empty key is refused before anything is sent', async () => {
  const row = recorded('upsert of a new id on a hash bucket');
  const { client, sent } = recordingClient(answerTo(row));
  await assert.rejects(client.database('v280').hash('users').upsert('', { Name: 'Ada' }), (error: unknown) => {
    assert.ok(error instanceof InvalidArgumentError);
    assert.equal(error.operation, 'upsert');
    assert.match(error.message, /^upsert needs a key: a non-empty string, got an empty string\./);
    return true;
  });
  assert.equal(sent.length, 0);
});

test('upsert on a bucket with no key to replace is the server\'s InvalidArgumentError, nothing written', async () => {
  for (const name of ['upsert on a fifo bucket is refused', 'upsert on a blob bucket is refused']) {
    const row = recorded(name);
    const { client } = recordingClient(answerTo(row));
    await assert.rejects(client.database('v').bucket('target').upsert('ada', { Born: 1815, Name: 'Ada' }), (error: unknown) => {
      assert.ok(error instanceof InvalidArgumentError, name);
      assert.equal(error.writeOutcome, 'not_applied', name);
      assert.match(error.message, /^Bucket "target" is a (fifo|blob) bucket/, name);
      return true;
    });
  }
});

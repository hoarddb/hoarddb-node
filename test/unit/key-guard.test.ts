// SPDX-License-Identifier: Apache-2.0
//
// A keyed write names its key. From plain JavaScript nothing stops a caller passing undefined, null, a
// number or an object, and the server reads a missing or empty key as "assign one": the write then
// lands under a key nobody asked for, a new one on every call. So upsert, put and putBlob refuse any
// key that is not a non-empty string before a frame exists.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { InvalidArgumentError } from '../../src/errors.js';
import type { OpName } from '../../src/wire/opcodes.js';
import { recordingClient } from '../helpers/recording.js';

const STORED = { id: 'server-assigned', success: true, message: '' };
const BAD_KEYS: readonly (readonly [string, unknown])[] = [
  ['undefined', undefined],
  ['null', null],
  ['a number', 5],
  ['an object', {}],
  ['an empty string', ''],
];

function recording() {
  return recordingClient(
    new Map<OpName, Record<string, unknown>>([
      ['PUT', STORED],
      ['UPSERT', STORED],
      ['BLOB_WRITE', { success: true, key: 'server-assigned', blobid: 'b', size: 1 }],
    ]),
  );
}

async function assertRefused(call: Promise<unknown>, operation: string, label: string): Promise<void> {
  await assert.rejects(call, (error: unknown) => {
    assert.ok(error instanceof InvalidArgumentError, `${operation}(${label}): InvalidArgumentError, got ${String(error)}`);
    assert.equal(error.operation, operation);
    assert.equal(error.writeOutcome, 'not_applied', `${operation}(${label})`);
    assert.equal(error.wireCode, null, `${operation}(${label}): refused by the driver, not the server`);
    assert.match(error.message, new RegExp(`^${operation} needs a key: a non-empty string, got ${label}\\.`));
    return true;
  });
}

test('upsert refuses a key that is not a non-empty string, and sends nothing', async () => {
  for (const [label, key] of BAD_KEYS) {
    const { client, sent } = recording();
    await assertRefused(client.database('app').hash('users').upsert(key as string, { Name: 'Ada' }), 'upsert', label);
    assert.equal(sent.length, 0, `upsert(${label}) sent a request`);
  }
});

test('put refuses a key that is not a non-empty string, and sends nothing', async () => {
  for (const [label, key] of BAD_KEYS) {
    const { client, sent } = recording();
    await assertRefused(client.database('app').hash('users').put(key as string, { Name: 'Ada' }), 'put', label);
    assert.equal(sent.length, 0, `put(${label}) sent a request`);
  }
});

test('putBlob refuses a key that is not a non-empty string, and sends nothing', async () => {
  for (const [label, key] of BAD_KEYS) {
    const { client, sent } = recording();
    await assertRefused(client.database('app').blob('files').putBlob(key as string, new Uint8Array([1])), 'putBlob', label);
    assert.equal(sent.length, 0, `putBlob(${label}) sent a request`);
  }
});

test('the refusal of an empty key names insert, the verb that lets the server assign one', async () => {
  const { client } = recording();
  await assert.rejects(client.database('app').hash('users').put('', { Name: 'Ada' }), /use insert\(doc\) to let the server assign/);
  await assert.rejects(client.database('app').hash('users').upsert('', { Name: 'Ada' }), /use insert\(doc\) to let the server assign/);
});

test('insert still sends an empty key, and a real key is sent as given', async () => {
  const { client, sent } = recording();
  const users = client.database('app').hash('users');
  await users.insert({ Name: 'Ada' });
  await users.put('ada', { Name: 'Ada' });
  await users.upsert('ada', { Name: 'Ada' });
  assert.deepEqual(
    sent.map((request) => [request.op, request.fields['key']]),
    [
      ['PUT', ''],
      ['PUT', 'ada'],
      ['UPSERT', 'ada'],
    ],
  );
});

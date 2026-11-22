// SPDX-License-Identifier: Apache-2.0
//
// bson promotes any embedded document holding $ref and $id to a DBRef, and reads a genuine dbPointer
// (wire type 0c) as a DBRef too. The codec tells the two apart by the type byte of the stored element,
// which only the raw bytes have, and refuses the genuine one alone.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { decodeDocument, encodeDocument, isOpaque } from '../../src/codec/index.js';
import { dbPointer, document, element, embeddedRef, string } from '../helpers/raw-bson.js';
import { bytesToHex } from '../helpers/vectors.js';

function refusal(work: () => unknown): Error {
  try {
    work();
  } catch (error) {
    return error as Error;
  }
  assert.fail('expected a refusal');
}

test('an embedded document holding $ref and $id is a plain object', () => {
  const read = decodeDocument(document(embeddedRef('link', 'users', 'u1')), 'safe');
  assert.deepEqual(read, { link: { $ref: 'users', $id: 'u1' } });
  assert.equal(Object.getPrototypeOf(read['link']), Object.prototype, 'a plain object, not a DBRef');
});

test('$db and further fields of such a document are kept', () => {
  const bytes = document(
    embeddedRef('link', 'users', 'u1', element(0x02, '$db', string('app')), element(0x02, 'note', string('kept'))),
  );
  assert.deepEqual(decodeDocument(bytes, 'safe'), { link: { $ref: 'users', $id: 'u1', $db: 'app', note: 'kept' } });
});

test('such a document written back has the bytes it was read from', () => {
  const bytes = document(embeddedRef('link', 'users', 'u1'), embeddedRef('other', 'orders', 'o9'));
  assert.equal(bytesToHex(encodeDocument(decodeDocument(bytes, 'safe'))), bytesToHex(bytes));
});

test('a reference whose $id is an object id keeps it as an Opaque and writes back the same bytes', () => {
  const id = element(0x07, '$id', new Uint8Array(12).fill(0x22));
  const bytes = document(element(0x03, 'link', document(element(0x02, '$ref', string('c')), id)));
  const read = decodeDocument(bytes, 'safe') as { link: Record<string, unknown> };
  assert.ok(isOpaque(read.link['$id']), 'the object id is an Opaque');
  assert.equal(bytesToHex(encodeDocument(read)), bytesToHex(bytes));
});

test('references inside arrays and nested documents are plain objects too', () => {
  const list = element(0x04, 'list', document(embeddedRef('0', 'a', 'b'), embeddedRef('1', 'c', 'd')));
  const nest = element(0x03, 'nest', document(element(0x03, 'inner', document(element(0x02, '$ref', string('x')), element(0x02, '$id', string('y'))))));
  assert.deepEqual(decodeDocument(document(list, nest), 'safe'), {
    list: [{ $ref: 'a', $id: 'b' }, { $ref: 'c', $id: 'd' }],
    nest: { inner: { $ref: 'x', $id: 'y' } },
  });
});

test('a genuine dbPointer is still refused, and the refusal names its field', () => {
  const raised = refusal(() => decodeDocument(document(dbPointer('a')), 'safe'));
  assert.match(raised.message, /dbPointer/);
  assert.match(raised.message, /field "a"/);
});

test('beside an ordinary reference, only the genuine dbPointer is refused, in either order', () => {
  const first = refusal(() => decodeDocument(document(dbPointer('real'), embeddedRef('plain', 'users', 'u1')), 'safe'));
  assert.match(first.message, /field "real"/);
  assert.doesNotMatch(first.message, /field "plain"/);

  const second = refusal(() => decodeDocument(document(embeddedRef('plain', 'users', 'u1'), dbPointer('real')), 'safe'));
  assert.match(second.message, /field "real"/);
  assert.doesNotMatch(second.message, /field "plain"/);
});

test('a dbPointer inside an array is named by its position', () => {
  const list = element(0x04, 'x', document(embeddedRef('0', 'a', 'b'), dbPointer('1')));
  const raised = refusal(() => decodeDocument(document(list), 'safe'));
  assert.match(raised.message, /field "x\[1\]"/);
});

// SPDX-License-Identifier: Apache-2.0
//
// A value the driver refuses to read is its own error, and it names the document and the field the
// way the program wrote them: the key of a document (or its place in a page), and the path inside
// that document, not the path inside the server's answer.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { UnreadableValueError } from '../../src/errors.js';
import { decodeResponse } from '../../src/wire/messages.js';
import {
  bsonUndefined,
  dbPointer,
  document,
  element,
  outOfRangeDate,
  stringElement,
} from '../helpers/raw-bson.js';

const TRUE = new Uint8Array([1]);

function failure(work: () => unknown): UnreadableValueError {
  try {
    work();
  } catch (error) {
    assert.ok(error instanceof UnreadableValueError, `expected an UnreadableValueError, got ${String(error)}`);
    return error;
  }
  assert.fail('expected a refusal');
}

const found = element(0x08, 'found', TRUE);

test('a get answer names the document by its key and the field without the answer\'s "data."', () => {
  const answer = document(found, element(0x03, 'data', document(stringElement('_id_', 'ada'), outOfRangeDate('when'))));
  const raised = failure(() => decodeResponse('GET', answer, 'safe'));
  assert.equal(raised.code, 'UNREADABLE_VALUE');
  assert.equal(raised.valueKind, 'datetime');
  assert.equal(raised.document, 'ada');
  assert.equal(raised.field, 'when');
  assert.match(raised.message, /"ada"/);
  assert.match(raised.message, /field "when"/);
  assert.doesNotMatch(raised.message, /data\./);
});

test('a field inside a nested document or an array is a path from the user\'s document', () => {
  const nested = document(found, element(0x03, 'data', document(stringElement('_id_', 'n'), element(0x03, 'profile', document(outOfRangeDate('born'))))));
  assert.equal(failure(() => decodeResponse('GET', nested, 'safe')).field, 'profile.born');

  const list = document(
    found,
    element(0x03, 'data', document(stringElement('_id_', 'l'), element(0x04, 'list', document(stringElement('0', 'x'), stringElement('1', 'y'), bsonUndefined('2'))))),
  );
  const raised = failure(() => decodeResponse('GET', list, 'safe'));
  assert.equal(raised.field, 'list[2]');
  assert.equal(raised.valueKind, 'undefined');
});

test('a find page names the refused document by its key and its index in the page', () => {
  const page = document(
    found,
    element(
      0x04,
      'documents',
      document(
        element(0x03, '0', document(stringElement('_id_', 'ada'), stringElement('name', 'Ada'))),
        element(0x03, '1', document(stringElement('_id_', 'zed'), dbPointer('link'))),
        element(0x03, '2', document(stringElement('_id_', 'bob'))),
      ),
    ),
  );
  const raised = failure(() => decodeResponse('SCAN', page, 'safe'));
  assert.equal(raised.document, 'zed');
  assert.equal(raised.index, 1);
  assert.equal(raised.field, 'link');
  assert.equal(raised.valueKind, 'dbPointer');
  assert.match(raised.message, /"zed"/);
  assert.match(raised.message, /index 1 of this page/);
  assert.doesNotMatch(raised.message, /documents\[/);
});

test('a document without an _id_ is named by its index alone', () => {
  const page = document(found, element(0x04, 'documents', document(element(0x03, '0', document(stringElement('name', 'x'))), element(0x03, '1', document(outOfRangeDate('t'))))));
  const raised = failure(() => decodeResponse('SCAN', page, 'safe'));
  assert.equal(raised.document, undefined);
  assert.equal(raised.index, 1);
  assert.match(raised.message, /document at index 1 of this page/);
});

test('an update reply holding a refused value names the document in the reply', () => {
  const reply = document(element(0x08, 'success', TRUE), element(0x03, 'doc', document(stringElement('_id_', 'ada'), outOfRangeDate('when'))));
  const raised = failure(() => decodeResponse('UPDATE', reply, 'safe'));
  assert.equal(raised.document, 'ada');
  assert.equal(raised.field, 'when');
});

test('a refused value outside any document of the user\'s keeps the answer\'s own path', () => {
  const nodes = document(element(0x04, 'nodes', document(element(0x03, '0', document(outOfRangeDate('joinedat'))))));
  const raised = failure(() => decodeResponse('LIST_NODES', nodes, 'safe'));
  assert.equal(raised.document, undefined);
  assert.equal(raised.index, undefined);
  assert.equal(raised.field, 'nodes[0].joinedat');
});

test('the three kinds each say what the value is', () => {
  const kinds: [Uint8Array, RegExp][] = [
    [outOfRangeDate('v'), /datetime outside the range/],
    [bsonUndefined('v'), /BSON undefined/],
    [dbPointer('v'), /dbPointer/],
  ];
  for (const [value, wording] of kinds) {
    const answer = document(found, element(0x03, 'data', document(stringElement('_id_', 'k'), value)));
    assert.match(failure(() => decodeResponse('GET', answer, 'safe')).message, wording);
  }
});

test('bytes that are not a document still fail as they did: not an UnreadableValueError', () => {
  assert.throws(
    () => decodeResponse('GET', new Uint8Array([0x05, 0x00, 0x00, 0x00, 0x01]), 'safe'),
    (error: unknown) => !(error instanceof UnreadableValueError),
  );
});

// The advice names operations that exist: a find projection that leaves the field out, and an update
// with $unset or $set. The decoder that "keeps the raw value" it used to recommend does not exist.
test('every kind says how to read the rest of the document and how to repair the field', () => {
  const values: [string, Uint8Array][] = [
    ['datetime', outOfRangeDate('when')],
    ['undefined', bsonUndefined('when')],
    ['dbPointer', dbPointer('when')],
  ];
  for (const [kind, value] of values) {
    const answer = document(found, element(0x03, 'data', document(stringElement('_id_', 'ada'), value)));
    const message = failure(() => decodeResponse('GET', answer, 'safe')).message;
    assert.match(message, /find\(\{\}, \{ projection: \{ when: 0 \} \}\)/, `${kind}: the projection that leaves the field out`);
    assert.match(message, /update\('ada', \{ \$unset: \['when'\] \}\)/, `${kind}: the $unset repair`);
    assert.match(message, /\$set/, `${kind}: the $set repair`);
    assert.doesNotMatch(message, /decoder that keeps the raw value/, `${kind}: no advice to use what does not exist`);
  }
});

test('a nested field is excluded and unset by its path; a value inside an array by its array field', () => {
  const nested = document(found, element(0x03, 'data', document(stringElement('_id_', 'n'), element(0x03, 'profile', document(outOfRangeDate('born'))))));
  const dotted = failure(() => decodeResponse('GET', nested, 'safe')).message;
  assert.match(dotted, /projection: \{ 'profile\.born': 0 \}/);
  assert.match(dotted, /\$unset: \['profile\.born'\]/);

  const inArray = document(found, element(0x03, 'data', document(stringElement('_id_', 'l'), element(0x04, 'list', document(stringElement('0', 'x'), bsonUndefined('1'))))));
  const whole = failure(() => decodeResponse('GET', inArray, 'safe')).message;
  assert.match(whole, /field "list\[1\]"/, 'the value is still named where it is');
  assert.match(whole, /projection: \{ list: 0 \}/, 'but it is excluded as the whole array');
  assert.match(whole, /\$unset: \['list'\]/);
});

test('without a key the advice shows where the key goes', () => {
  const page = document(found, element(0x04, 'documents', document(element(0x03, '0', document(outOfRangeDate('t'))))));
  assert.match(failure(() => decodeResponse('SCAN', page, 'safe')).message, /update\(<key>, \{ \$unset: \['t'\] \}\)/);
});

// SPDX-License-Identifier: Apache-2.0
//
// A value the codec cannot read faithfully (a datetime outside the Date range, a BSON undefined, a
// genuine dbPointer) is refused on read with an UnreadableValueError that names the field and says
// how to repair it, never turned into an Invalid Date, a missing field or another BSON type; a Date
// outside the range is refused on write before any byte. Ported from the org hoarddb-node repository
// (commits 9b0200d, 8e34099, de49a4d, ed2951c); the BSON corpus vectors it named are built by hand.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { decodeDocument, encodeDocument } from '../../src/codec/index.js';
import { InvalidArgumentError, UnreadableValueError } from '../../src/errors.js';
import { bsonUndefined, dbPointer, document, element, outOfRangeDate } from '../helpers/raw-bson.js';

function raisedBy(work: () => unknown): unknown {
  try {
    work();
  } catch (error) {
    return error;
  }
  return undefined;
}

function refusal(work: () => unknown): UnreadableValueError {
  const raised = raisedBy(work);
  assert.ok(raised instanceof UnreadableValueError, `expected an UnreadableValueError, got ${String(raised)}`);
  return raised;
}

test('datetime: an out-of-range datetime is refused on read, int64 max and min alike', () => {
  const min = element(0x09, 'a', new Uint8Array([0, 0, 0, 0, 0, 0, 0, 0x80]));
  for (const bytes of [document(outOfRangeDate('a')), document(min)]) {
    const raised = refusal(() => decodeDocument(bytes, 'safe'));
    assert.equal(raised.code, 'UNREADABLE_VALUE');
    assert.equal(raised.valueKind, 'datetime');
    assert.equal(raised.field, 'a');
    assert.match(raised.message, /datetime/);
    assert.match(raised.message, /field "a"/);
    assert.match(raised.message, /int64|ISO 8601/, 'it says what to store instead');
  }
});

test('undefined: a BSON undefined is refused on read rather than dropped on write', () => {
  const raised = refusal(() => decodeDocument(document(bsonUndefined('a')), 'safe'));
  assert.equal(raised.valueKind, 'undefined');
  assert.match(raised.message, /BSON undefined/);
  assert.match(raised.message, /null|omit/, 'it says what to store instead');
});

test('dbPointer: a genuine dbPointer is refused on read rather than written back as a document', () => {
  const raised = refusal(() => decodeDocument(document(dbPointer('a')), 'safe'));
  assert.equal(raised.valueKind, 'dbPointer');
  assert.match(raised.message, /dbPointer/);
  assert.match(raised.message, /plain document/, 'it says what to store instead');
});

test('a nested field and an array position are named as a path', () => {
  const nested = document(element(0x03, 'profile', document(outOfRangeDate('born'))));
  assert.equal(refusal(() => decodeDocument(nested, 'safe')).field, 'profile.born');
  const list = document(element(0x04, 'list', document(element(0x02, '0', new Uint8Array([2, 0, 0, 0, 0x78, 0])), bsonUndefined('1'))));
  assert.equal(refusal(() => decodeDocument(list, 'safe')).field, 'list[1]');
});

test('a Date outside the range is refused before any byte, naming the field', () => {
  const raised = raisedBy(() => encodeDocument({ t: new Date(Number.NaN) }));
  assert.ok(raised instanceof InvalidArgumentError, `expected an InvalidArgumentError, got ${String(raised)}`);
  assert.match(raised.message, /field "t"/);
  assert.match(raised.message, /Invalid Date/);
  assert.match(raised.message, /Nothing was sent/);
  assert.match(raised.message, /int64|ISO 8601/);
});

// The advice names operations that exist: a find projection that leaves the field out, and an update
// with $unset or $set.
test('every kind says how to read the rest of the document and how to repair the field', () => {
  const values: [string, Uint8Array][] = [
    ['datetime', outOfRangeDate('when')],
    ['undefined', bsonUndefined('when')],
    ['dbPointer', dbPointer('when')],
  ];
  for (const [kind, value] of values) {
    const message = refusal(() => decodeDocument(document(value), 'safe')).message;
    assert.match(message, /find\(\{\}, \{ projection: \{ when: 0 \} \}\)/, `${kind}: the projection that leaves the field out`);
    assert.match(message, /update\(<key>, \{ \$unset: \['when'\] \}\)/, `${kind}: the $unset repair`);
    assert.match(message, /\$set/, `${kind}: the $set repair`);
  }
});

test('a nested field is excluded and unset by its path; a value inside an array by its array field', () => {
  const nested = refusal(() => decodeDocument(document(element(0x03, 'profile', document(outOfRangeDate('born')))), 'safe')).message;
  assert.match(nested, /projection: \{ 'profile\.born': 0 \}/);
  assert.match(nested, /\$unset: \['profile\.born'\]/);
  const inArray = document(element(0x04, 'list', document(bsonUndefined('0'))));
  const whole = refusal(() => decodeDocument(inArray, 'safe')).message;
  assert.match(whole, /field "list\[0\]"/);
  assert.match(whole, /projection: \{ list: 0 \}/);
  assert.match(whole, /\$unset: \['list'\]/);
});

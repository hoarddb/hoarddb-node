// SPDX-License-Identifier: Apache-2.0
//
// The nine update operators (build doc section 3.9). The driver checks the shape of what it is given
// and nothing the server owns: it never parses a path, never reorders operators and never decides
// whether a field can take an operator. What it does decide is how a number is written, because that
// is lost silently if it is wrong: $inc is int64 and $mul is a double, whatever JavaScript calls the
// value.

import { asDouble } from './codec/values.js';
import { InvalidArgumentError, type ErrorContext } from './errors.js';

export const UPDATE_OPERATORS = ['$set', '$unset', '$inc', '$push', '$addToSet', '$mul', '$min', '$max', '$rename'] as const;
export type UpdateOperator = (typeof UPDATE_OPERATORS)[number];

/** The wire field of each operator: the server's one-word names, $addToSet being `addtoset`. */
export const UPDATE_WIRE_FIELD: Readonly<Record<UpdateOperator, string>> = Object.freeze({
  $set: 'set',
  $unset: 'unset',
  $inc: 'inc',
  $push: 'push',
  $addToSet: 'addtoset',
  $mul: 'mul',
  $min: 'min',
  $max: 'max',
  $rename: 'rename',
});

/** The form each operator's refusal shows (the shell's own forms). */
const FORMS: Readonly<Record<UpdateOperator, string>> = {
  $set: '{$set: {field: value}}',
  $unset: '{$unset: ["a", "b"]}',
  $inc: '{$inc: {field: N}}',
  $push: '{$push: {field: value}}',
  $addToSet: '{$addToSet: {field: value}}',
  $mul: '{$mul: {field: N}}',
  $min: '{$min: {field: value}}',
  $max: '{$max: {field: value}}',
  $rename: '{$rename: {oldName: "newName"}}',
};

const INT64_MIN = -(2n ** 63n);
const INT64_MAX = 2n ** 63n - 1n;
const TWO_POW_63 = 2 ** 63;

/** A value as the refusals print it: numbers and bigints literally, a string quoted, anything else by kind. */
function show(value: unknown): string {
  if (typeof value === 'number') return String(value);
  if (typeof value === 'bigint') return `${String(value)}n`;
  if (typeof value === 'string') return JSON.stringify(value);
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  if (typeof value === 'object') return 'an object';
  return `a ${typeof value}`;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** The entries of an operand document with the `undefined` ones dropped. */
function present(operand: Record<string, unknown>): [string, unknown][] {
  return Object.entries(operand).filter(([, value]) => value !== undefined);
}

/**
 * Section 3.9's local checks, in its order, and the UPDATE request's operator fields under their wire
 * names, only for the operators left with something to say. Throws InvalidArgumentError; nothing is
 * sent, so the write is safe to repeat (not_applied).
 */
export function updateFields(ops: unknown, ctx: ErrorContext): Record<string, unknown> {
  const refuse = (message: string): never => {
    throw new InvalidArgumentError({
      message,
      operation: ctx.operation,
      ...(ctx.target === undefined ? {} : { target: ctx.target }),
      writeOutcome: 'not_applied',
    });
  };

  if (!isPlainObject(ops)) refuse('update needs an operator document, for example {$set: {field: value}}');
  const given = ops as Record<string, unknown>;
  const keys = Object.keys(given).filter((key) => given[key] !== undefined);
  for (const key of keys) {
    if (!(UPDATE_OPERATORS as readonly string[]).includes(key)) {
      refuse(`${key} is not supported — supported update operators: ${UPDATE_OPERATORS.join(', ')}`);
    }
  }

  const fields: Record<string, unknown> = {};
  for (const operator of UPDATE_OPERATORS) {
    const operand = given[operator];
    if (operand === undefined) continue;

    if (operator === '$unset') {
      if (!Array.isArray(operand) || !operand.every((name) => typeof name === 'string')) {
        refuse('$unset needs a list of field names: {$unset: ["a", "b"]}');
      }
      if ((operand as string[]).length > 0) fields[UPDATE_WIRE_FIELD[operator]] = [...(operand as string[])];
      continue;
    }

    if (!isPlainObject(operand)) refuse(`${operator} needs a document: ${FORMS[operator]}`);
    const entries = present(operand as Record<string, unknown>);

    if (operator === '$inc') {
      for (const [key, value] of entries) {
        const whole =
          (typeof value === 'number' && Number.isInteger(value) && value >= -TWO_POW_63 && value < TWO_POW_63) ||
          (typeof value === 'bigint' && value >= INT64_MIN && value <= INT64_MAX);
        if (!whole) {
          refuse(
            `$inc on "${key}" needs a whole number that fits in 64 bits, got ${show(value)}: write a whole number, or $set the new value: {$set: {${key}: <value>}}`,
          );
        }
      }
    } else if (operator === '$mul') {
      for (const [key, value] of entries) {
        if (typeof value !== 'number' || !Number.isFinite(value)) {
          refuse(
            `$mul on "${key}" needs a finite number, got ${show(value)}: write a number, or $set the new value: {$set: {${key}: <value>}}`,
          );
        }
      }
    } else if (operator === '$rename') {
      for (const [key, value] of entries) {
        if (typeof value !== 'string') {
          refuse(`$rename of "${key}" needs the new name as a string, got ${show(value)}: write {$rename: {oldName: "newName"}}`);
        }
      }
    }

    if (entries.length === 0) continue;
    const kept: Record<string, unknown> = {};
    for (const [key, value] of entries) {
      // int64 on the wire however the caller wrote the number; a double for $mul, even when whole.
      if (operator === '$inc') kept[key] = BigInt(value as number | bigint);
      else if (operator === '$mul') kept[key] = asDouble(value as number);
      else kept[key] = value;
    }
    fields[UPDATE_WIRE_FIELD[operator]] = kept;
  }

  if (Object.keys(fields).length === 0) {
    refuse(
      `update needs at least one operator with at least one field, from ${UPDATE_OPERATORS.join(', ')}: for example {$set: {field: value}}`,
    );
  }
  return fields;
}

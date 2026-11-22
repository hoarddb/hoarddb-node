// SPDX-License-Identifier: Apache-2.0
//
// One counter for every refusal a program sees (poolStats().errors). Rather than ask each verb to
// remember to count, every public method of the client and of each handle is wrapped once, here,
// after its class is defined: a refusal that leaves a public method, thrown or rejected, is counted,
// and a cursor the method returns counts the refusals of its pages. The count is once per refusal
// (src/call.ts countRefusal), so one raised deep and passed up through several public methods, or
// already counted by call(), is not counted again. Internal helpers are ES private methods, which
// are not on the prototype and so are never wrapped; the few internals one class calls on another are
// named in `shared` and left alone.

import { Cursor, countCursorRefusals } from './cursor.js';

type Method = (this: object, ...args: unknown[]) => unknown;

/** The wrapped methods, so a test can prove that every public method counts. */
const countingMethods = new WeakSet<object>();

/** True for a method countRefusalsOf wrapped. */
export function countsRefusals(method: unknown): boolean {
  return typeof method === 'function' && countingMethods.has(method);
}

export function countRefusalsOf(
  prototype: object,
  counterOf: (self: object) => ((error: unknown) => void) | undefined,
  shared: readonly string[] = [],
): void {
  for (const name of Object.getOwnPropertyNames(prototype)) {
    if (name === 'constructor' || shared.includes(name)) continue;
    const descriptor = Object.getOwnPropertyDescriptor(prototype, name);
    if (descriptor === undefined || typeof descriptor.value !== 'function') continue;
    const original = descriptor.value as Method;
    const counting = function (this: object, ...args: unknown[]): unknown {
      const count = counterOf(this) ?? ((): void => undefined);
      let returned: unknown;
      try {
        returned = original.apply(this, args);
      } catch (error) {
        count(error);
        throw error;
      }
      if (returned instanceof Promise) {
        return returned.catch((error: unknown) => {
          count(error);
          throw error;
        });
      }
      if (returned instanceof Cursor) countCursorRefusals(returned, count);
      return returned;
    };
    Object.defineProperty(counting, 'name', { value: name });
    countingMethods.add(counting);
    Object.defineProperty(prototype, name, { ...descriptor, value: counting });
  }
}

// SPDX-License-Identifier: Apache-2.0
//
// Everything the driver reads or writes BSON with, in one place: raw.ts (the bytes), values.ts
// (the values that cross the seam) and ejson.ts (the vectors' text form). bson is named nowhere
// else in the package.

export {
  decodeDocument,
  elementOf,
  encodeDocument,
  valueFromElement,
} from './raw.js';
export type { Int64Mode } from './raw.js';

export {
  OPAQUE_TYPE_BY_BYTE,
  fromWire,
  inheritDetails,
  isOpaque,
  makeOpaque,
  refusalDetails,
  toWire,
  unreadableMessage,
  whereText,
} from './values.js';
export type { Opaque, OpaqueType } from './values.js';

export {
  bytesFromExtendedJson,
  extendedJsonFromBytes,
  valuesFromExtendedJson,
} from './ejson.js';
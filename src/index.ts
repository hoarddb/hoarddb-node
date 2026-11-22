// SPDX-License-Identifier: Apache-2.0
//
// The package's public surface (build doc section 3.8): every type of the public API, connect(), the
// first-sight trust callback, the cursor, the error classes and the version. Nothing else is exported.

export type * from './types.js';
export { connect } from './client.js';
export { acceptFirstSight } from './first-sight.js';
export { Cursor } from './cursor.js';
export {
  AbortedError,
  AlreadyExistsError,
  AuthenticationError,
  BatchTooLargeError,
  ClaimEntryTooLargeError,
  ClientClosedError,
  ConfigError,
  ConflictError,
  ConnectionError,
  DeadMoveRefusedError,
  DuplicateKeyError,
  FieldTypeError,
  FrameTooLargeError,
  HoardDBError,
  InternalError,
  InvalidArgumentError,
  LeaseExpiredError,
  LeaseUnknownError,
  NotAuthenticatedError,
  NotFoundError,
  OverloadedError,
  PermissionDeniedError,
  PoolTimeoutError,
  ProtocolError,
  QuotaExceededError,
  RequestTimeoutError,
  ResultTooLargeError,
  TlsTrustError,
  UnavailableError,
  UnreadableValueError,
  UnsupportedFeatureError,
  UnsupportedVersionError,
  WriteConcernTimeoutError,
  isHoardDBError,
  type AuthFailReason,
  type ErrorCode,
  type UnreadableKind,
  type WriteOutcome,
} from './errors.js';
export { DRIVER_VERSION } from './version.js';

// SPDX-License-Identifier: Apache-2.0
//
// The public types, held to what the build doc promises (section 3): what must compile does, and every
// line preceded by @ts-expect-error must stay an error, or this file stops compiling.

import type { Client, Database, Doc, HeapBucket, OpenedBucket, Stored } from '../../src/index.js';

interface User {
  name: string;
  age: number;
}

declare const db: Database;
declare const client: Client;
const users = db.hash<User>('users');
const queue = db.fifo('q');
const heap = db.heap('h');
const files = db.blob('f');

function expectType<T>(value: T): void {
  void value;
}

export function positives(): void {
  expectType<Promise<Stored<User>>>(users.get('k'));
  void users.upsert('k', { name: 'a', age: 1 }, { writeConcern: 'majority' });
  void db.btree<User>('t').upsert('k', { name: 'a', age: 1 });
  void db.bucket<User>('b').upsert('k', { name: 'a', age: 1 });
  expectType<Promise<HeapBucket<Doc>>>(db.createBucket('x', 'heap'));
  expectType<Promise<OpenedBucket<Doc>>>(db.open('x'));
  expectType<Database>(client.defaultDatabase());
  // No priority: allowed, the server stores it at 0 (D-10).
  void heap.push({ a: 1 });
  void heap.push({ a: 1 }, { priority: 5n });
  expectType<Promise<Stored<User>>>(
    users.update('k', {
      $set: { 'Address.City': 'London' },
      $unset: ['draft'],
      $inc: { age: 1, visits: 2n },
      $push: { tags: 'x' },
      $addToSet: { tags: 'y' },
      $mul: { score: 1.5 },
      $min: { low: 1 },
      $max: { high: 9 },
      $rename: { nick: 'handle' },
    }),
  );
}

export function negatives(): void {
  // @ts-expect-error a fifo bucket has no get
  void queue.get('k');
  // @ts-expect-error a fifo bucket has no upsert: a queue has no key to replace
  void queue.upsert('k', { a: 1 });
  // @ts-expect-error a blob bucket has no upsert
  void files.upsert('k', { a: 1 });
  // @ts-expect-error nmae is not a field of User
  void users.upsert('k', { nmae: 'a', age: 1 });
  // @ts-expect-error a hash bucket has no push
  void users.push({ name: 'a', age: 1 });
  // @ts-expect-error a blob bucket has no find
  void files.find({});
  // @ts-expect-error 'quorum' is not a write concern
  void users.put('k', { name: 'a', age: 1 }, { writeConcern: 'quorum' });
  // @ts-expect-error nmae is not a field of User
  void users.find({ nmae: 'x' });
  // @ts-expect-error $eq is not a filter operator
  void users.find({ name: { $eq: 'x' } });
  // @ts-expect-error $pull is not one of the nine update operators
  void users.update('k', { $pull: { a: 1 } });
  // @ts-expect-error $unset takes a list of names
  void users.update('k', { $unset: { age: '' } });
  // @ts-expect-error $mul takes numbers
  void users.update('k', { $mul: { age: '2' } });
  // @ts-expect-error $rename takes a string new name
  void users.update('k', { $rename: { name: 5 } });
  // @ts-expect-error $set is held to the document type
  void users.update('k', { $set: { age: 'x' } });
  // @ts-expect-error a hash bucket has no range
  void users.range({});
}

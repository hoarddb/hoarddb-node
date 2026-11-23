<!-- SPDX-License-Identifier: Apache-2.0 -->
# hoarddb

The Node.js driver for hoardDB. It speaks hoardDB's own protocol over TLS, pins the server's key, and
is written in TypeScript with one runtime dependency (the codec that reads and writes the wire format).

**Status: pre-release (0.1.0), and it does not speak the ring protocol yet.** Read the next section before
you build on it.

## What this driver reaches on a v1.1 server

A hoardDB v1.1 server is a ring server: a bucket declares fields, and a field can be a store (a queue, a
table, a heap) that every document carries for itself. The `hoarddb` command line, `hoarddb dump` and
`hoarddb restore` work on that data.

This driver was written before the ring. It sends the opcodes of the server's earlier single-store engine,
in which a bucket has one of six store types (hash, btree, fifo, lifo, heap and blob). Against a v1.1.0
server:

- **It works.** It connects, logs in with the same users, and reads and writes: the server still answers
  these opcodes. The five-minute path below and `examples/hash.mjs` were run against a v1.1.0 server.
- **On a hash or btree bucket `put` inserts and never replaces.** A `put` of a key that already holds a
  document is refused with `DocumentExistsError` (`code` `DOCUMENT_EXISTS`), and nothing is written
  (`writeOutcome` is `not_applied`). `upsert(key, doc)` replaces the document or creates it, and
  `update(key, ops)` changes some of its fields. The blocks below store their sample documents with
  `upsert`, so each runs any number of times.
- **The other store types do not refuse a `put` of a held key.** Through an untyped handle
  (`database.bucket(name)`), a `put` on a fifo or lifo bucket adds another entry with the same `_id_`, and
  a `put` on a heap bucket silently replaces the entry that holds that `_id_` at priority 0. Neither is an
  error. Use `push` on those types; `upsert` is refused on them, and a blob bucket refuses `put`.
- **Its data is separate.** Its databases and buckets live in the earlier engine's own store. Nothing it
  creates is visible to the `hoarddb` command line or to a ring client, nothing created there is visible to
  it, and `hoarddb dump` does not include it. A database named `app` can exist on both sides, and they are
  two different databases.
- **Its data is on one node.** A v1.1.0 server refuses to start in the earlier engine's replicated mode, so
  on a cluster each node answers these opcodes from its own local store: a write through this driver stays
  on the node that took it and is not copied to the others. `alterBucket` to a replication factor above 1
  is refused, and every `writeConcern` level behaves the same.
- **There is no ring client for Node.js yet.** The Go module `github.com/hoarddb/hoarddb-go` has one, in
  its package `ring`.

## Install

The package is not published to npm: `package.json` is `"private": true`, so
`npm install hoarddb` does not work. Build a tarball from a clone of this repository and install that:

```bash
git clone https://github.com/hoarddb/hoarddb-node.git
cd hoarddb-node
npm ci          # the pinned toolchain
npm run build   # dist/: the ES module and CommonJS builds (npm pack also runs it, as prepack)
npm pack        # hoarddb-0.1.0.tgz
cd /your/project && npm install /path/to/hoarddb-node/hoarddb-0.1.0.tgz
```

It needs Node 22 or later, and it works from ES modules and from CommonJS. **TypeScript:** `Client` is
`AsyncDisposable` (for `await using`), so your `tsconfig.json` needs `"lib"` to include `"ESNext.Disposable"`
(for example `"lib": ["ES2022", "ESNext.Disposable"]`), or `"skipLibCheck": true`.

## Examples

Runnable examples, one per store type plus the quickstart (ES module and CommonJS), errors, trust and
store fields, copies of a bucket (`alter.mjs`), live in this repository's `examples/` folder. They are not in the tarball. To run one
against a server, from the root of the clone after `npm run build`:

```bash
HOARDDB_URI='hoarddb://admin@127.0.0.1:7433/?fingerprint=SHA256:<the server fingerprint>' \
HOARDDB_ROOT_PASSWORD=<the server password> node examples/hash.mjs
```

## The five-minute path

Build `hoarddb-server` from [`github.com/hoarddb/hoarddb-server`](https://github.com/hoarddb/hoarddb-server)
(no release binary is published yet). Start it with a password, and copy the fingerprint from its
`TCP driver listener listening` log line:

```bash
HOARDDB_ROOT_PASSWORD=choose-a-long-password hoarddb-server
# ... "msg":"TCP driver listener listening","address":"127.0.0.1:7433","fingerprint":"SHA256:79bb6170..."
```

Then, with the same password in your environment (`HOARDDB_ROOT_PASSWORD`), in an ES module:

```js
import { connect } from 'hoarddb';

const client = await connect('hoarddb://admin@localhost:7433?fingerprint=SHA256:79bb6170...');
try {
  await client.createDatabase('app', { ifNotExists: true });
  const users = await client.database('app').createBucket('users', 'hash', { ifNotExists: true });

  // upsert stores the document or replaces it, so this program runs any number of times.
  // put stores a new document only: on a key that is already there it throws DocumentExistsError.
  await users.upsert('ada', { name: 'Ada', age: 36 });
  console.log(await users.get('ada')); // { _id_: 'ada', age: 36, name: 'Ada' }
  for await (const user of users.find({ age: { $gte: 30 } })) console.log(user.name);
} finally {
  await client.close();
}
```

The same program in CommonJS, which has no top-level `await`:

```cjs
const { connect } = require('hoarddb');

async function main() {
  const client = await connect('hoarddb://admin@localhost:7433?fingerprint=SHA256:79bb6170...');
  try {
    await client.createDatabase('app', { ifNotExists: true });
    const users = await client.database('app').createBucket('users', 'hash', { ifNotExists: true });
    await users.upsert('ada', { name: 'Ada', age: 36 });
    console.log(await users.get('ada'));
  } finally {
    await client.close();
  }
}
main().catch((err) => { console.error(err.message); process.exitCode = 1; });
```

With a document type, a wrong field name or a wrong verb is a compile error:

```ts
import { connect } from 'hoarddb';

interface User {
  name: string;
  age: number;
}

const client = await connect();
const users = client.database('app').hash<User>('users');
await users.upsert('ada', { name: 'Ada', age: 36 });
const ada = await users.get('ada'); // Stored<User>; a missing key throws NotFoundError
console.log(ada.name);
// @ts-expect-error nmae is not a field of User, so this line does not compile
await users.find({ nmae: 'x' }).toArray();
await client.close();
```

`connect()` with no arguments reads `HOARDDB_URI` (default `hoarddb://localhost`), and the user and password
from `HOARDDB_ROOT_USER` (default `admin`) and `HOARDDB_ROOT_PASSWORD`. A URI carries the host list, an
optional `user:password@`, a `/database/bucket` default (`client.defaultDatabase()` and
`client.defaultBucket()` return them), and `fingerprint`, `authToken`, `clientName` and `dialTimeoutMs`
parameters. Percent-encode `@`, `/`, `?` and `:` inside a user name or password (%40, %2F, %3F, %3A): an
unencoded one can change which host the credentials go to. Every connection option can also be given in code and then wins over the URI.

## Trusting a server

The driver never talks to a server whose key it has not been told to trust, and nothing, your password
included, is written before the key is decided. Trust a server one of three ways, in this order:

1. **Pin it.** Put the fingerprint in the URI (`?fingerprint=SHA256:...`) or in `tls.fingerprints`.
2. **Record it.** The hoardDB command-line tool writes `~/.hoarddb/known_servers`, and the driver reads it.
3. **Decide in code.** `tls.onUnknownServer` is called with the host, port and fingerprint; returning `true` accepts and records the key.

```ts
import { acceptFirstSight, connect } from 'hoarddb';

const pinned = await connect('hoarddb://admin@db.example.com:7433?fingerprint=SHA256:79bb6170...');
await pinned.close();

// Local development only: accept the first key a host shows, the way an SSH client does.
const local = await connect('hoarddb://admin@localhost:7433', { tls: { onUnknownServer: acceptFirstSight } });
await local.close();

// Verification off, with a reason that is printed as a warning on every connection.
const rig = await connect('hoarddb://admin@localhost:7433', { tls: { insecure: { reason: 'throwaway test rig' } } });
await rig.close();
```

Accepting on first sight trusts whatever answers first, so an attacker present at that moment is trusted
for good; pin the fingerprint wherever you can. A key that changes after it was recorded is always a hard
failure (`TLS_KEY_CHANGED`), never a prompt.

## The six store types

A bucket has one type, chosen when it is created. Every verb is on the type that answers it, and the
compiler refuses the others. Every write takes `{ writeConcern: 'one' | 'majority' | 'all' }` (against a
v1.1.0 server a bucket of this driver has one copy, so the levels behave the same), and every call takes `{ signal, timeoutMs }`. A verb that returns a list (`pop`, `peek`, `claim`, `deadList`) answers
`[]` when there is nothing and never throws for emptiness. A verb that returns one value (`get`, `findOne`,
`update`, btree `first` and `last`, `getBlob`, and a store field's `get` and `getBlob`) throws `NotFoundError`
(`err.code === 'NOT_FOUND'`) on a miss, so a miss and a stored `null` are never confused. Deleting a missing
key is `false`, not an error.

### hash

Keyed documents with secondary indexes. `put`, `upsert`, `insert` (the server assigns the key), `insertMany`, `get`
(`{ consistent: true }` asks for a quorum read; with one copy it is an ordinary read), `exists`, `delete`, `update`, `count`, `find`, `findOne`,
`distinct` and `search`.

```ts
import { connect } from 'hoarddb';

const client = await connect();
const people = await client.database('app').createBucket('people', 'hash', {
  ifNotExists: true,
  indexes: [{ fields: ['city'] }],
});
await people.upsert('ada', { name: 'Ada', city: 'London' });
const { id } = await people.insert({ name: 'Grace', city: 'New York' });
console.log(id, await people.exists('ada'), await people.count());
for await (const person of people.search({ city: 'London' })) console.log(person.name);
await client.close();
```

On a hash or btree bucket, `put(key, doc)` stores a new document and never replaces one: a key that already holds a document is
`DocumentExistsError` (`DOCUMENT_EXISTS`), nothing is written, and the error's `hint` names the two calls
that do change a stored document. `upsert(key, doc)` replaces the document under the key, or creates it:
a field the new document lacks is gone, and the document's store fields are kept. `update(key, ops)`
changes some fields and leaves the rest. `insert` and `insertMany` are refused the same way for a
`_id_` that is already held, and `insertMany` is refused whole. An `upsert` is never resent after a lost
answer, because a resend would overwrite a write that landed in between: read the document back first.
This refusal is the hash and btree buckets' only: a fifo or lifo bucket takes a second entry with the same
`_id_`, and a heap bucket replaces the entry that holds the `_id_` at the same priority (see the top of this
file).

```ts
import { connect, DocumentExistsError } from 'hoarddb';

const client = await connect();
const people = await client.database('app').createBucket('people', 'hash', { ifNotExists: true });
await people.upsert('grace', { name: 'Grace', city: 'New York' });
try {
  await people.put('grace', { name: 'Grace Hopper' });
} catch (err) {
  if (!(err instanceof DocumentExistsError)) throw err;
  console.log(err.code, err.writeOutcome); // DOCUMENT_EXISTS not_applied
  await people.upsert('grace', { name: 'Grace Hopper', city: 'Arlington' });
}
await client.close();
```

A `search` returns at most `limit` results (default 100) and does not page. `cursor.total` is the number
returned, not the number that match; `cursor.hasMore` is `true` when more matches exist beyond `limit`, so
raise `limit`, or use `find` (whose `total` is the exact match count) when the count matters.

### btree

The same verbs as hash, keys kept in order, plus `range`, `first` and `last`.

```ts
import { connect } from 'hoarddb';

const client = await connect();
const scores = await client.database('app').createBucket('scores', 'btree', { ifNotExists: true });
await scores.upsert('alice', { points: 9 });
for await (const entry of scores.range({ gte: 'a', lte: 'm' })) console.log(entry.key, entry.value.points);
console.log((await scores.first()).key, (await scores.last()).key);
await client.close();
```

### fifo and lifo

`push`, `pop` and `peek`; a fifo returns the oldest first, a lifo the newest. `count` and `find` work as on
the others.

`pop` and `peek` both answer a list, in pop order. `pop()` removes one entry; `pop({ limit: n })` removes up
to `n` (1 to 100) in one request, and fewer is not an error: it took all that existed. An empty store gives
`[]`. A pop consumes, so it is never retried: if the answer is lost the error says `outcome unknown: the pop
may have removed up to N entries; run peek to see what is left`. Every store type that pops, and a store
field's `pop`, takes the same `limit`.

```ts
import { connect } from 'hoarddb';

const client = await connect();
const jobs = await client.database('app').createBucket('jobs', 'fifo', { ifNotExists: true });
await jobs.push({ task: 'send the invoice' });
console.log((await jobs.peek({ limit: 5 })).length, await jobs.pop(), await jobs.pop({ limit: 10 }));
await client.close();
```

### Leases, consume and the dead list

A fifo, lifo or heap can hand out entries under a **lease** instead of removing them (at-least-once). `claim`
takes up to `limit` entries (1 to 100, default 1) for `lease` milliseconds (1000 to 3600000, default 30000) and
leaves them in the store, invisible to `pop`, `peek` and `find`; `ack` removes them, `release` gives them back at
once, and `extend` moves the deadline and resolves to the length the server **granted**. An entry whose lease runs
out is delivered again, and after 5 deliveries without an ack it moves to the dead list.

```ts
import { connect } from 'hoarddb';

const client = await connect();
const jobs = client.database('app').fifo('jobs');
const claimed = await jobs.claim({ limit: 10, lease: 60_000 });
for (const job of claimed.items) {
  console.log(job.itemId, job.document, job.deliveries); // deliveries is 1 on the first claim
}
await jobs.ack(claimed.leaseId, { itemIds: claimed.items.map((job) => job.itemId) }); // or no itemIds: the whole lease
const granted = claimed.items[0] ? await claimed.items[0].extend(30_000) : 0;
console.log(granted, claimed.pending, claimed.dead, claimed.returned);
```

Nothing to take is a `Claimed` with `items: []`, not an error (`returned` above 0 means expired leases went back:
claim again at once). `ack`, `release` and `extend` of a lease nothing holds throw `LeaseUnknownError`, of one whose
time ran out `LeaseExpiredError`; both carry `result`. An entry over the size a claim moves is
`ClaimEntryTooLargeError` (also an `InvalidArgumentError`): `pop()` it and claims work again. A claim, ack,
release, extend, requeue or discard is a write and is **never resent** after a lost answer; a lost claim costs one
lease of delay and a lost ack a redelivery, never an entry.

`consume` is the loop: it claims `limit` entries (default 10) for `lease` (default 30000 ms), runs the handler for
each at the same time, and acknowledges the ones whose handler resolved. A handler gets an `AbortSignal` that ends
at the lease minus a margin (a tenth of the lease, at least 250 ms); a handler that needs longer calls
`delivery.extend(ms)`. A handler that throws is not acknowledged and its entry is delivered again.

```ts
import { connect } from 'hoarddb';

const client = await connect();
const jobs = client.database('app').fifo('jobs');
const stop = new AbortController();
process.once('SIGINT', () => stop.abort());
try {
  await jobs.consume(async (job, signal) => {
    await handle(job.document, signal); // resolve to ack, throw to have it delivered again
  }, { limit: 10, lease: 30_000, signal: stop.signal });
} catch (error) {
  if ((error as { code?: string }).code !== 'ABORTED') throw error; // stopped on purpose
}
declare function handle(document: object, signal: AbortSignal): Promise<void>;
```

`consume` backs off (100 ms doubling to 5 s) when the queue is empty and after `UNAVAILABLE` (a lost connection
too), `TIMEOUT` and `OVERLOADED` on a claim or an ack, and after an ack of an expired or unknown lease. It ends,
rejecting with the error, on `INVALID_ARGUMENT` (a bad option, `ClaimEntryTooLargeError`, a hash bucket),
`PERMISSION_DENIED`, `NOT_FOUND`, `INTERNAL` and any other error. When `signal` aborts it waits for every handler,
releases what it has not acknowledged and rejects with `AbortedError` (`code: 'ABORTED'`).

`deadList({ limit, after })` reads a page (1 to 1000, default 10; `next` is the cursor for `after`; an empty list is
an empty page). `requeue(selector)` puts entries back in the queue and `discard(selector)` drops them; the selector
is `{ byId: deadId }` or `{ all: true, after? }` (at most 100 entries per request: repeat while `done` is above 0).
Both resolve to `{ done, left, refused, message }`; when the server refuses some, they throw `DeadMoveRefusedError`
carrying that `result`, and the entries that moved stay moved.

```ts
import { connect } from 'hoarddb';

const client = await connect();
const jobs = client.database('app').fifo('jobs');
const page = await jobs.deadList({ limit: 100 });
for (const dead of page.items) console.log(dead.deadId, dead.reason, dead.deliveries, dead.document);
await jobs.requeue({ all: true });
```

### heap

`push` with an optional `priority` (a whole number, default 0), `pop` and `peek`; the heap serves the
highest priority first.

```ts
import { connect } from 'hoarddb';

const client = await connect();
const tasks = await client.database('app').createBucket('tasks', 'heap', { ifNotExists: true });
await tasks.push({ title: 'fix the bug' }, { priority: 10 });
await tasks.push({ title: 'no priority given' });
console.log((await tasks.pop())[0]?.title);
await client.close();
```

### blob

Bytes under a key, with metadata beside them: `putBlob`, `getBlob`, `delete`, `count`. The server's
default limit is 16 MiB a blob; a larger value is refused with `INVALID_ARGUMENT`.

```ts
import { connect } from 'hoarddb';

const client = await connect();
const files = await client.database('app').createBucket('files', 'blob', { ifNotExists: true });
await files.putBlob('hello.txt', new TextEncoder().encode('hello'), { metadata: { type: 'text/plain' } });
const blob = await files.getBlob('hello.txt');
console.log(new TextDecoder().decode(blob.data));
await client.close();
```

## Updates

`update(key, operators)` changes one document in one request and resolves the new document, or throws
`NotFoundError` when the key does not exist (an update never creates a document). An update is all or nothing: when the server refuses one operator, nothing in the
update is written. The nine operators:

| Operator | Rule | Example |
|---|---|---|
| `$set` | stores each value; a missing intermediate document inside the path is created (`Address` in `Address.City`); the document itself must exist | `{ $set: { 'Address.City': 'London' } }` |
| `$unset` | removes fields; takes a list of names | `{ $unset: ['draft'] }` |
| `$inc` | adds a whole number (a `number` or a `bigint`, sent as 64 bits) | `{ $inc: { visits: 2 } }` |
| `$push` | appends to an array, even a value already there | `{ $push: { tags: 'poetry' } }` |
| `$addToSet` | appends unless an equal value is already there | `{ $addToSet: { tags: 'poetry' } }` |
| `$mul` | multiplies by a number (fractions allowed, sent as a double) | `{ $mul: { score: 1.5 } }` |
| `$min` | keeps the smaller of the stored and the given value | `{ $min: { age: 30 } }` |
| `$max` | keeps the larger | `{ $max: { best: 99 } }` |
| `$rename` | moves a field to a new name; does nothing if the new name exists | `{ $rename: { nick: 'handle' } }` |

```ts
import { connect } from 'hoarddb';

const client = await connect();
const users = await client.database('app').createBucket('users', 'hash', { ifNotExists: true });
await users.upsert('ada', { name: 'Ada', visits: 1, tags: ['maths'] });
const updated = await users.update('ada', { $set: { city: 'London' }, $inc: { visits: 2 }, $push: { tags: 'poetry' } });
console.log(updated);
await client.close();
```

A malformed operator document (an unknown operator, `$unset` given a document, `$inc` given 1.5) is
refused locally with `INVALID_ARGUMENT` and nothing is sent. Keys may be paths: `Address.City`,
`Lines[3].Qty`; the server reads them.

## Copies of a bucket

`database.alterBucket(name, { replicationFactor })` asks for a bucket's replication factor to be raised or
lowered. It needs the `bucket_rf` capability (`UnsupportedFeatureError`, nothing sent, without it) and a
whole number of at least 1. A v1.1.0 server refuses a factor above 1 for this driver's buckets with
`InvalidArgumentError`: the earlier engine runs on one node only (see "What this driver reaches on a v1.1
server"). `examples/alter.mjs` shows the call and prints the refusal.

```ts
import { connect } from 'hoarddb';

const client = await connect();
const result = await client.database('app').alterBucket('orders', { replicationFactor: 3, timeoutMs: 30_000 });
console.log(result.previousFactor, '->', result.replicationFactor, 'copying to', result.pending ?? []);
await client.close();
```

## Store fields

A bucket can declare fields that are themselves stores of any of the six types, one per document. A user's
purchases are that user's own fifo:

```ts
import { connect } from 'hoarddb';

const client = await connect();
const users = await client.database('app').createBucket('User', 'hash', {
  ifNotExists: true,
  stores: [
    { name: 'Purchases', type: 'fifo' },
    { name: 'Friends', type: 'hash' },
  ],
});
await users.upsert('ada', { Name: 'Ada' });
const purchases = users.field('ada', 'Purchases');
await purchases.push({ item: 'book' });
console.log(await purchases.len(), (await purchases.pop())[0]?.element);
await users.field('ada', 'Friends').put('bob', { since: 2020 });
await client.close();
```

`field(key, name)` does no I/O and costs nothing until a verb is called. A store held inside an element
of another store is reached with `.field(element, name)` again.

`info()` is on every bucket handle, of any type. It asks the server what the bucket is declared as, in one
round trip, and never walks a store, so its cost does not grow with the number of elements a store field
holds (`stats()` counts them). Use it to learn which store fields a bucket has and what each one is:

```ts
import { connect, isHoardDBError } from 'hoarddb';

const client = await connect();
try {
  const declaration = await client.database('app').bucket('User').info();
  console.log(`${declaration.name} is a ${declaration.type} bucket with ${declaration.entries} documents`);
  for (const field of declaration.storeFields) console.log(`  ${field.name}: ${field.engine}`);
} catch (err) {
  if (isHoardDBError(err) && err.code === 'NOT_FOUND') console.log(err.message);
  else throw err;
}
await client.close();
```

`storeFields[].engine` is the word the server sends (`hash`, `btree`, `fifo`, `lifo`, `heap` or `blob`); a word
this driver does not know is passed through unchanged. `replicationFactor` and `inherited` are absent when the
server sends none. A bucket or database that does not exist is `NOT_FOUND`, and `info()` is a read, so a lost
connection is retried once.

## Errors

Every failure is a `HoardDBError` with a stable `code`, the server's own `message` word for word (one
exception: when a write is refused or lost without the server saying whether it was applied, the driver
adds one documented sentence, "The outcome is unknown: read it back before resending, and do not resend a
push, a pop or an increment."; a current server stamps `not_applied` on every refusal it decides before
applying anything, so you see the sentence only for a lost answer, a store failure or an older server), and fields that say what
to do next: `operation`, `target`, `requestId`, `retryable`, `writeOutcome`
(`applied`, `not_applied` or `unknown`) and, where they apply, `copiesConfirmed`, `replicationFactor` and
`hint`. Branch on `err.code`, not on `instanceof`: a program that loads both the ES module and the
CommonJS build has two copies of every class, and the code string is the same in both.

A single-value miss is `NOT_FOUND` too: `get` of a missing key, `findOne` with no match, `update` of a missing
key, btree `first`/`last` of an empty tree, `getBlob` of a missing key, and a store field's `get`/`getBlob` of
a missing element. Before this rule they resolved `null`; migrate `if (doc === null) { ... }` to

```ts
import { connect, isHoardDBError } from 'hoarddb';

const client = await connect();
const users = client.database('app').hash('users');
try {
  const doc = await users.get('ada');
  console.log(doc);
} catch (err) {
  if (isHoardDBError(err) && err.code === 'NOT_FOUND') console.log('no such user');
  else throw err;
}
await client.close();
```

(`err instanceof NotFoundError` works too within one copy of the package; `err.code` also works across the ES and
CommonJS builds.) A list that may be empty is `find(...).toArray()`, `peek()` or `pop()`.

```ts
import { connect, isHoardDBError } from 'hoarddb';

const client = await connect();
try {
  await client.database('app').hash('missing').get('ada');
} catch (err) {
  if (isHoardDBError(err) && err.code === 'NOT_FOUND') console.log(err.message);
  else throw err;
}
await client.close();
```

The codes the server sends are `NOT_FOUND`, `ALREADY_EXISTS`, `PERMISSION_DENIED`, `INVALID_ARGUMENT`,
`INTERNAL`, `UNAVAILABLE`, `TIMEOUT` (a write concern that timed out, the write is stored),
`CONFLICT`, `QUOTA_EXCEEDED`, `UNSUPPORTED_VERSION`, `NOT_AUTHENTICATED`, `OVERLOADED`,
`RESULT_TOO_LARGE`, `DUPLICATE_KEY`, `FIELD_TYPE`, `BATCH_TOO_LARGE` and `DOCUMENT_EXISTS` (a `put`, `insert` or
`insertMany` of a key that already holds a document; see "hash"); a code newer than this driver is `UNKNOWN(<n>)`.
A verb the bucket's store type does not answer (`range` on a hash, `update` on a queue, `search` on a blob) is `INVALID_ARGUMENT`, with a message that names the bucket, its type and the type the verb needs.
`EARLY_DATA_REJECTED` is a retired code: the server never sends it, but the driver still decodes it. The driver's own are `CONNECTION_FAILED`, `TLS_UNTRUSTED`, `TLS_FINGERPRINT_MISMATCH`,
`TLS_KEY_CHANGED`, `AUTH_FAILED` (with a `reason`), `PROTOCOL_ERROR`, `REQUEST_TIMEOUT`, `ABORTED`,
`CLIENT_CLOSED`, `POOL_TIMEOUT`, `FRAME_TOO_LARGE`, `UNREADABLE_VALUE`, `INVALID_URI`, `INVALID_OPTIONS` and
`UNSUPPORTED_FEATURE`.

`UNREADABLE_VALUE` (`UnreadableValueError`) is a stored value the driver refuses to read because reading it would
later alter the data (see "BSON values"). It names the field inside the document (`field`) and, when the answer
says which document it is in, the document (`document`, the key; `index`, its place in a find page). A stored
datetime outside the range a `Date` holds, a BSON `undefined` and a dbPointer are refused this way, and the
message says how to read the rest of the document and how to repair the field.

When a write fails after it was sent and no answer came back, `writeOutcome` is `unknown`: read the
document back before you send it again, and never resend a push, a pop or an increment.

## Retries

The driver retries only what is safe, and says so on the error (`retryable`). A read is retried once on a new
connection if the connection is lost, and with a backoff while the server says `UNAVAILABLE`. A write is
never sent twice by the driver: not after a lost connection, not after a timeout. A write refused with
`UNAVAILABLE` and `not_applied` is retried with a backoff within its deadline.

`OVERLOADED` has two forms. When the server refuses the connection itself (the refusal has no request ID: it
served nothing and read no request), the driver backs off and sends the request again, a write included. When
an `OVERLOADED` answers a request by its own ID, a read is resent, but a write may have been applied, so it is
sent once: the error has `writeOutcome` `unknown` and the documented sentence ("read it back before
resending" for a DDL request, with the no-resend-of-a-push-or-increment warning for a data write), unless the
server stamped an outcome. A stamped `not_applied` is still resent.

`NOT_AUTHENTICATED` is retried once on a new connection for a read. A wrong password, a rate limit, a refused key and every local
error are never retried. `BATCH_TOO_LARGE` is never retried as sent: on a standalone node (`not_applied`) `insertMany` halves the
batch and resends each half automatically, as it always has for the old in-band refusal, down to one document, whose refusal is the
caller's; a refusal stamped `unknown` is never split, because it may have been applied, so it goes to the caller, who
reads back first. Backoff is full jitter, up to 5 seconds, and never past the call's deadline.

## BSON values

| In JavaScript | On the wire |
|---|---|
| `string`, `boolean`, `null` | the same |
| `number` | int32 when whole and in range, else double |
| `bigint` | int64 |
| `Date` | datetime (milliseconds) |
| `Uint8Array`, `Buffer` | binary |
| arrays and plain objects | arrays and documents |
| a value with no JavaScript form (an object id, a timestamp, a decimal, binary with a subtype, a regex) | an `Opaque`, written back exactly as it was read; a regex is the one exception, below |

A 64-bit integer reaches JavaScript as a `number` when it is exactly representable and as a `bigint`
otherwise (`int64: 'safe'`, the default); `int64: 'bigint'` gives a `bigint` always. A `Map`, a class instance
or a function is refused before anything is sent.

**What a read followed by a write changes.** Everything not listed here comes back as the same value, and an
`Opaque` is written back as it was read. Three things change:

- A stored symbol is read as a string and written back as a string.
- A regex keeps its pattern and its options, but the options are stored in sorted order: a regex stored with
  options `"xi"` is written back with `"ix"`. It is the same regex in other bytes.
- A stored double with an integral value (`3.0`) is read as the number 3 and written back as an int32, which
  is how BSON meets JavaScript.

A stored datetime outside the range a `Date` holds (±8.64e15 ms from the epoch), a BSON `undefined` and a
dbPointer are refused when read, so they are never returned as an `Invalid Date`, an absent field or another
type; the refusal names the document and the field and says how to repair it. An ordinary embedded document
that holds `$ref` and `$id` is data, not a dbPointer, and comes back as the plain object it was.

## Things worth knowing

- **A cursor is not a snapshot.** `find`, `range` and a store field's `list` fetch one page at a time; a
  document inserted or deleted between two pages can show twice or be missed. A page too large for the server's
  result ceiling is halved as often as it takes.
- **`listBuckets` is an operator call.** It returns every bucket of a database in one answer, so do not call it
  on a path a user waits for in a database with a very large number of buckets.
- **A handle costs almost nothing.** `client.database(name)`, `db.hash(name)` and `bucket.field(key, name)`
  hold a reference and a few strings: no socket, no timer, no cache entry. Make as many as you like; the driver
  never keeps a registry of them. `poolStats()` is aggregate, never per bucket.
- **The pool** has two lanes per client, point calls and bulk calls, and dials lazily.

## Changes before 1.0

Before 1.0 a change is made directly and recorded in `CHANGELOG.md`. The latest: `pop()` returns a list and
takes `limit` (see "fifo and lifo"); `const [job] = await queue.pop()` replaces `const job = await queue.pop()`.

## What this driver does not do

The ring protocol (see the top of this file), user administration, query pipelining, multi-document updates (`filter`, `multi`), a batch upsert (`upsert` takes one document), the `$pull`
operator, SRV connection strings, and reading an authentication token from the environment.

## Testing

`npm run check` type-checks, lints (licence headers, banned words, the import boundary) and runs the unit
tests; it needs no server, and prints the test count when it finishes. `npm run build` and
`npm run pack:check` build the package and prove the tarball installs from ES modules and from CommonJS.
`scripts/compliance-check.sh` checks the licences, the dependency set, the import boundary, banned names
and private references.

`npm run test:server` (the frozen vectors replayed against a real server, the cluster tests, and every file
in `examples/`; it prints its own count) needs a `hoarddb-server` binary and the built package, so run
`npm run build` first. The tests take the binary from the `HOARDDB_SERVER_BIN` environment variable:

```bash
npm run build
export HOARDDB_SERVER_BIN=/path/to/hoarddb-server   # a binary you built from the hoardDB server repository
npm run test:server
```

Build that binary from tag `v1.1.0` of the server repository to repeat the run below. The vectors under
`testdata/driver-vectors/` name, in `server_commit`, the server they were captured from.

**What was run against v1.1.0.** `npm run test:server` against a server built from tag `v1.1.0`: 129 of its
138 tests pass. The nine that do not are not driver failures:

- **Eight are the whole cluster test file, `test/server/cluster.test.ts`.** It starts three nodes in the
  earlier engine's replicated mode, and a v1.1.0 server refuses to start in that mode, so these tests cannot
  run against v1.1.0 at all. Nothing in this driver was tested against a v1.1.0 cluster.
- **One is a replayed vector, "user drop of the last administrator".** v1.1.0 refuses the request, as the
  vector records, with the same code, but its sentence is worded differently from the recorded one. The replay
  sent 267 vectors and the other 266 answered as recorded.

Every file in `examples/` and both quick starts above were also run twice in a row against that server.

`testing/server.json` is the manifest of a test-server download (`scripts/fetch-server.sh`). No test-server
release is published, the file says so, and the server it names is older than v1.1.0 and than the vectors: it
is not what the tests are run against. Build the binary yourself and pass it in `HOARDDB_SERVER_BIN`.

### Conformance with the shared BSON corpus

`testdata/bson-vectors/v1.json` (196 vectors, shared by every driver) is replayed through the codec by
`test/unit/bson-corpus.test.ts`. 186 vectors pass every check. 10 differ, in 15 entries (one vector can differ
in more than one check) listed with a verdict and a reason in `test/unit/bson-known-differences.json`; the replay
fails on a vector that is not listed and on a listed vector that now agrees, so the list cannot go stale.

- **Refused on purpose (5 vectors):** a datetime beyond the `Date` range (two vectors), a BSON `undefined`, a
  dbPointer and the every-type document that holds the last two are refused when read (see "BSON values"), so
  the corpus's write-back checks for them differ.
- **Same value, other form (4 vectors):** a symbol written back as a string, the double `3.0` written back as
  an int32, a repeated key reduced to its last value and regex options stored sorted (see "BSON values").
- **Accepted (1 vector):** the corpus names a key that is not valid UTF-8 as refused. The server accepts it
  too, and the codec reads the key with replacement characters: key UTF-8 is not checked. The replay fails if
  the codec starts refusing it.

Every entry is either deliberate or acceptable, and none is open.

A key holding NUL and a value nested past 100 levels are refused before anything is sent, as
`InvalidArgumentError`; an answer nested past 100 levels is refused as undecodable.

## Contributing

`handbook/` and `testdata/` describe the earlier engine's protocol, the one this driver sends, and are not
edited here: if one is wrong, open an issue that says what you read and what you observed. The ring
protocol is described in the handbook of the `hoarddb-go` repository. Pull requests to the code are welcome.

## Compatibility

| Driver | Server | What was run |
|---|---|---|
| 0.1.0 | hoardDB v1.1.0, one node, the earlier engine's store only | both quick starts and every file in `examples/`, each twice in a row |
| 0.1.0 | hoardDB v1.1.0, one node, the earlier engine's store only | `npm run test:server`: 129 of 138 pass; the cluster test file cannot start on v1.1.0 and one replayed vector's wording differs (see "Testing") |

## Licence

Apache-2.0.

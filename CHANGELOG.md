# Changelog

The driver is before 1.0: a change is made directly, with no alias, and recorded here.

The driver sends the opcodes of the hoardDB server's earlier single-store engine, not the ring protocol
of a v1.1 server (see the README, "What this driver reaches on a v1.1 server"). Entries below that mention
a cluster, a cluster owner or copies of a bucket describe that engine's replicated mode, which a v1.1.0
server refuses to start in.

## Unreleased

### Changed

- **`put`, `upsert` and `putBlob` refuse a key that is not a non-empty string** (`undefined`, `null`, a number, an
  object, `''`) with `InvalidArgumentError` before anything is sent. The server reads a missing or empty key as
  "assign one", so such a call stored a new document under a key nobody chose, a new one on every call; a number
  or an object came back as the server's `INTERNAL` and cost the connection. `put('', doc)` used to act as
  `insert(doc)`: call `insert`. The read verbs, `update`, `delete` and the store-field verbs are unchanged: the
  server refuses a missing key on each of them and nothing is written.
- **On a hash or btree bucket, `put` of a key that already holds a document is `DocumentExistsError`** (`code` `DOCUMENT_EXISTS`, wire code
  `0x12`), with `writeOutcome: 'not_applied'` and a `hint` that names `upsert(key, doc)` and `update(key, ops)`. It
  was reported as `InternalError` with `code` `UNKNOWN(18)` and the hint to upgrade the driver, and it cost the
  connection. On those two types the server's `put` inserts and never replaces; `insert` and `insertMany` are
  refused the same way for an `_id_` that is already held, and `insertMany` is refused whole. A program that
  relied on `put` to overwrite calls `upsert`. Matches the Go driver's `ErrDocumentExists`. The other types do
  not refuse: a fifo or lifo bucket adds another entry with the same `_id_`, and a heap bucket replaces the
  entry that holds the `_id_` at the same priority.
- The README's quick starts and its hash, btree, update and store-field blocks store their sample documents with
  `upsert`, so each runs any number of times; the clone line uses `https`.
- `handbook/operations.md` said `put` replaces and that a `put` to a blob bucket stores the document. On a hash or
  btree `put` never replaces, the handbook now says what a fifo, a lifo and a heap do with a held `_id_`, and a
  blob bucket refuses `put` and `insert`: write a blob with `putBlob`.
- `testdata/driver-vectors/v1.json` is the current shared file again (it was a copy from before `put` stopped
  replacing), and `test/unit/vectors-drift.test.ts` fails when a file under `testdata/` differs from the shared
  original beside the package in the hoardDB source tree.

- **A key holding NUL is an `InvalidArgumentError`**, not an `InternalError` ("put failed"), and a value nested past
  100 levels is an `InvalidArgumentError` before anything is sent (it overflowed the stack beyond a few thousand
  levels). An answer nested past 100 levels is refused as undecodable, as the server does. The shared BSON corpus
  is replayed by `test/unit/bson-corpus.test.ts`; see the README, "Conformance with the shared BSON corpus".
- **`ClaimEntryTooLargeError.code` is `INVALID_ARGUMENT`**, the wire code, not `CLAIM_ENTRY_TOO_LARGE` (handbook
  errors.md section 3: the code does not tell this refusal apart; the class is the sentinel, as the Go driver's
  `ErrClaimEntryTooLarge`). It is still an `InvalidArgumentError`; match it with `instanceof`.
- Connection-string parse errors no longer repeat the connection string. They say what is wrong (for example
  "the port in the connection string is not a number") without quoting the text, and a connection string with an
  `@` after its first `/` or `?` is refused with the fix: percent-encode `/` and `?` in the user name and password.
  A bad percent-escape in the path or query is now a `ConfigError` (`INVALID_URI`) instead of a bare `URIError`.
  Query names and values, host text, ports and the scheme are not repeated either (a name from the accepted or
  refused parameter sets is still named), and a string with more than one `@` before its query is refused the same way.

### Added

- **`upsert(key, doc)`** on hash and btree buckets and on an untyped handle (`UPSERT`, `0x16`, answered by
  `UPSERT_OK`, `0x17`): it replaces the document under the key, or creates it. A field the new document lacks is
  gone, and the document's store fields are kept. A fifo, lifo, heap or blob bucket refuses it with
  `InvalidArgumentError`; an empty key is refused before anything is sent. It is never resent after a lost answer.
  Matches the Go driver's `Bucket.Upsert`. `examples/hash.mjs` is the runnable example. A store field's
  `put(element, doc)` already replaces its element and is unchanged.
- `database.alterBucket(name, { replicationFactor })` changes how many copies of a bucket a cluster keeps
  (`ALTER_BUCKET`, `0x8E`) and resolves to `{ message, replicationFactor, previousFactor, pending?, releasing? }`:
  the members an increase newly places, and the members a decrease un-places. It needs the `bucket_rf`
  capability (`UnsupportedFeatureError`, nothing sent, without it) and a whole number of at least 1. A refusal an
  operator must act on is `InvalidArgumentError` with the server's sentence and is sent once; a refusal a retry
  clears is `UnavailableError` with `writeOutcome: 'not_applied'` and `retryable: true`, resent with backoff until
  the call's deadline. The vectors carry eight `alter bucket` rows; `examples/alter.mjs` is the runnable example.
  Matches the Go driver's `Database.AlterBucket`.
- **The owner's view of a bucket's copies** on `listBuckets()`, `bucket.info()` and `bucket.stats()`: `inSync`, `state`,
  `notInSync` and `pendingCopies` (handbook operations.md section 3), absent from a server that does not send
  them. `stats()` carries the same four, and the rest in `raw`.

- Error code `0x11` (`17`) is `BATCH_TOO_LARGE`, surfaced as `BatchTooLargeError` with the server's `write_outcome`
  carried as given (`not_applied` on a standalone node, `unknown` on a cluster owner's refusal). It is never retried
  as sent, and the connection survives the refusal. On a standalone node (`not_applied`) `insertMany` halves the batch
  and resends each half automatically, as it always has for the old in-band refusal; a cluster owner's `unknown`
  refusal is never split and goes to the caller, who reads back first.
- `client.defaultDatabase()` returns the database handle the URI path (`hoarddb://host/<database>`) or the
  `database` option names, with no I/O; with none it throws `ConfigError` (`INVALID_OPTIONS`) saying where the
  segment goes. Matches the Go driver's `Client.DefaultDatabase()`.
- **Leases and the dead list, matching the Go driver**, on fifo,
  lifo and heap buckets (and `defaultBucket()`): `claim({ limit, lease })`, `ack(leaseId, { itemIds })`,
  `release(leaseId)`, `extend(leaseId, ms)` (resolves to the length the server GRANTED), `consume(handler,
  { limit, lease, signal })`, `deadList({ limit, after })`, `requeue(selector)` and `discard(selector)`, with
  the Go driver's ranges (limit 1 to 100, lease 1000 to 3600000 ms, 100 item ids, dead limit 1 to 1000) and
  defaults (`consume`: limit 10, lease 30000 ms). New errors `LeaseUnknownError` (`LEASE_UNKNOWN`),
  `LeaseExpiredError` (`LEASE_EXPIRED`), `ClaimEntryTooLargeError` (code `INVALID_ARGUMENT` as on the wire; the class is the sentinel, as
  the Go driver's `ErrClaimEntryTooLarge`) and `DeadMoveRefusedError` (an `InvalidArgumentError` carrying `result`). Empty results
  are empty lists, never errors: `claim` of nothing is `{ items: [] }` and an empty dead list an empty page.
  The writes are never resent after a lost answer; `deadList` is a retried read. `consume` follows the Go
  loop exactly (see the README). Example: `examples/consume.mjs`.

### Changed (breaking)

- **A single-value miss throws `NotFoundError` instead of resolving `null`**. A verb that returns one value now throws `NotFoundError` (`err.code === 'NOT_FOUND'`) when
  there is nothing: `get` (hash and btree), `findOne`, `update` of a missing key, btree `first` and `last` of an
  empty tree, `getBlob`, and a store field's `get` and `getBlob`. Their types are `Promise<T>`, no longer
  `Promise<T | null>`, so a miss and a stored `null` are never confused. A verb that returns a list (`pop`,
  `peek`, and a field's) still answers `[]` on an empty result and never throws for emptiness (the driver has
  no `claim` or dead-list verb yet; they will follow the same rule). `delete` of nothing stays `false`.
  Migrate `if (doc === null)` to `try { const doc = await bucket.get(key); ... } catch (err) { if (err.code === 'NOT_FOUND') { ... } else throw err; }`
  (`err instanceof NotFoundError` also works within one copy of the package; `err.code` works across the ES and
  CommonJS builds). `cursor.next()` still returns `null` at the end of a cursor: it is an iterator, not a verb.
  The examples `blob`, `hash` and `fields` print `NOT_FOUND` for their miss; their golden outputs changed.
- **`pop()` returns a list and takes `limit`.** Every `pop` (fifo, lifo, heap buckets, and a store field's `pop`)
  now returns `Promise<Stored<T>[]>` (a field: `Promise<FieldEntry<E>[]>`), in pop order, and `[]` when nothing
  was removed; it used to return one document or `null`. `pop({ limit: n })` removes up to `n` entries
  (1 to 100, default 1) in one request; a `limit` outside that range is refused before anything is sent.
  Migrate `const job = await q.pop()` to `const [job] = await q.pop()` (`job` is `undefined` when empty), and
  `(await q.pop()) === null` to `(await q.pop()).length === 0`. Matches the Go driver's
  `Pop(ctx, WithLimit(n))` and the server's pop-n wire (`items` on the answer).
- A lost pop (the answer never arrived) says `outcome unknown: the pop may have removed up to N entries; run
  peek to see what is left`, N being the `limit` (1 when none), and is never retried.

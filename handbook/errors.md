# Errors, the write outcome, and what to retry

How a hoardDB server says no, and what a driver does about it. Language-neutral; binds every driver.
The single most important rule: **pass the server's message through verbatim.** The server writes its
refusals as sentences that name the fix ("… Run 'create database app' …", "… ask an administrator to
run: grant role …"). A driver that replaces one with "server error" has destroyed the fix.

## 1. The error frame

An error is an `ERROR` frame (`0xA2`) in place of the success opcode, echoing the request ID, with this
payload:

| Field | Type | Present |
|---|---|---|
| `code` | integer | always (decode any width) |
| `message` | string | always |
| `write_outcome` | string: `applied`, `not_applied`, `unknown` | on refusals of a write, and some others (section 4) |
| `copies_confirmed` | integer | with `write_outcome`, when the server knows it |
| `replication_factor` | integer | with `copies_confirmed` |
| `constraint_refusal` | bool | optional, with `INVALID_ARGUMENT`: the document itself is refused (a path the document cannot hold), the same on every copy, rather than the request being malformed. A driver may ignore it |
| `max_result_bytes` | integer | only with `RESULT_TOO_LARGE` |
| `retained_bytes` | integer | only with `RESULT_TOO_LARGE`; the encoded bytes the query had already kept when the refusal came — a lower bound on what it needed. **Absent when that is 0** (section 2) |

Tolerance rules, because an older server and a future bug look the same to a driver:

- A `code` of `0`, or no `code`, on an `ERROR` frame is `INTERNAL`. **Never success.**
- An unknown code `n` is kept as `UNKNOWN(n)` with the message, and treated like `INTERNAL`.
- An `ERROR` frame may be followed at once by the server closing the connection. A connection is reused
  after an `ERROR` frame **only** for the answers that are documented to leave it open (section 6);
  otherwise the driver discards it, or proves it with a `PING`.

## 2. The codes

| Code | Name | The server sends it for |
|---|---|---|
| `0x01` | `NOT_FOUND` | a missing bucket; a missing database (also for `list buckets` and `drop database`); a missing bucket for `bucket stats`, `bucket info` and `drop bucket`; an undeclared store field, or a field operation on a parent document that does not exist; a `GET_FAST` of a missing name; a user-administration command (`alter`, `drop`, `grant`, `revoke`) on a user that does not exist (`USER_GET` of one is `found: false`, not this error) |
| `0x02` | `ALREADY_EXISTS` | `create database` of a name that exists (`database "app" already exists`); `create bucket` of a name that exists **with another store type** (the message names both types and says a type cannot be changed in place); `USER_CREATE` of a name that exists |
| `0x03` | `PERMISSION_DENIED` | the user's grants do not cover the request (`auth.md` section 5); a backup or restore by a non-root user |
| `0x04` | `INVALID_ARGUMENT` | a document or blob over its limit; a `BLOB_WRITE` with no data; a write too large to replicate; a request frame over 32 MiB; a bad update operand; an unknown write-concern word, on a standalone node as on a cluster (a standalone node has no copies to wait for, but it does read the word, so an application tested on one node meets no new error on a cluster); a refused path; a bad store-field or typed-field declaration sent to `DECLARE_STORE_FIELDS`; a field verb the field's store type does not answer, or an incomplete field address; a verb the bucket's store type does not answer, any verb and any type (`operations.md` section 1: `GET` and `DELETE` off a hash, btree or blob, `FIFO_POP`, `FIFO_PEEK` and the lease and dead verbs off a fifo, lifo or heap, `FIFO_PUSH` and `BATCH_PUT` on a blob, `BTREE_*` off a btree, `BLOB_*` off a blob, `UPDATE` off a hash or btree, `SCAN`, `DISTINCT`, a filtered `COUNT` and `SEARCH` on a blob, `CONSISTENT_GET` off a hash or btree; the message says why and what to use, and ends with the verbs the type takes: `A hash bucket takes: put, insert, ...`); `EXISTS` with an empty key or on a bucket type with no keys (fifo, lifo, heap), which is never answered `exists: false`; a node-to-node opcode on the driver port; a request payload that is not well-formed BSON (the message names what was refused; a `GET_FAST` payload that does not decode is answered alike); a user-administration refusal for which the caller is at fault: an unknown or retired role, rejected credential material, a reused salt, an empty or reserved username, the last-administrator guard, the user ceiling (`auth.md` section 7) |
| `0x05` | `INTERNAL` | anything else, including an unsupported opcode; a write whose opcode the bucket's owner does not implement (a cluster whose members run different builds), refused before the owner logs it: `write_outcome: not_applied`, and the message names the owner and the opcode and says to upgrade that member or retry once every member runs the same build |
| `0x06` | `UNAVAILABLE` | the cluster cannot answer **here, now**, and nothing about the request is wrong (section 5); an operator's `migrate` that a node at or above its disk high-water mark refuses, because the refusal protects the node and the request is fine. The message names the node and says to free space; a retry of seconds does not clear a red disk, so a caller that retries `UNAVAILABLE` spends only the retries its deadline allows; a user-administration command on a node that is not the cluster's master, or that cannot reach a quorum, or whose member list is unconfirmed (`auth.md` section 7) |
| `0x07` | `TIMEOUT` | the write concern was not met in time. **The write is stored on the owner**: `write_outcome: applied`, with how many copies hold it. **Except a pop**: a pop the owner applied is answered with its entries as a success, never as this error (section 4, "A pop that removed an entry is answered success"); a `TIMEOUT` with `applied` on a pop is therefore an older server's answer, for a pop it applied or for one its handler refused (the result ceiling) whose wait then timed out, and the driver says `the pop was applied or refused and its answer carried no entries: it may have removed up to N entries; run peek to see what is left` |
| `0x08` | `CONFLICT` | a cluster member mismatch; a backup already running; a backup digest mismatch; a `USER_ALTER` whose `version` is not the user store's current one |
| `0x09` | `QUOTA_EXCEEDED` | not sent today |
| `0x0A` | `UNSUPPORTED_VERSION` | ALPN not served (connection-level); or a write to a bucket whose recorded typed-field declaration this server cannot enforce (written by a newer server, or failing this one's checks): **reads of that bucket still work**, the connection stays open, and no retry helps until an operator acts |
| `0x0B` | `EARLY_DATA_REJECTED` | never sent (retired) |
| `0x0C` | `NOT_AUTHENTICATED` | a request before AUTH succeeded |
| `0x0D` | `OVERLOADED` | connection-level: the server's or this address's connection budget is full |
| `0x0E` | `RESULT_TOO_LARGE` | a query result over the node's ceiling, or any response over 32 MiB; carries `max_result_bytes` and `retained_bytes` |
| `0x0F` | `DUPLICATE_KEY` | a write that would give a unique index a second document with the same key; nothing was stored |
| `0x10` | `FIELD_TYPE` | a document has a value of the wrong declared type, misses a required field, or has a top-level field name containing `.`, `[` or `]`; nothing was stored. The message names the field, the declared type, the type received and the fix |
| `0x11` | `BATCH_TOO_LARGE` | a batch put over the largest batch the store commits atomically, by bytes or by entry count (`wire.md` section 10). `write_outcome: not_applied` on a standalone node: nothing of the batch was written. **On a cluster the owner's refusal is `write_outcome: unknown`**, because the bound follows each member's memtable and a member with a larger one applies what the owner refused; the batch is almost always written nowhere, but a bucket that cannot take a duplicate (a queue, or a hash whose ids the server generated) is read back before the halves are sent. The message names both bounds, how many documents and how many encoded bytes the batch was, and the fix. **Split on the code and on nothing in the message**: halve the batch and resend. Only the batch put carries it; a pop, a claim or a store field's delete that does not fit the store's batch keeps its own code, and a document over its own limit is `INVALID_ARGUMENT` |

**The two `RESULT_TOO_LARGE` numbers and its advice.** `max_result_bytes` is the node's ceiling.
`retained_bytes` is the encoded bytes the query had already kept when adding the next element would
cross the ceiling — a lower bound on what the answer needed, not the size of the element that did not
fit. It is **absent when that is 0**: most often because the first element alone was over the ceiling,
so no `limit` can fit it, and only a projection or a higher ceiling (`HOARDDB_QUERY_MAX_RESULT_BYTES`)
will. A driver reads absence as 0. The message's fix is a sentence. A scan's ends with the fixed example `Ask for fewer documents per request
— {limit: 1000} and page with skip — or add a projection to return fewer fields`; **the `1000` is the
server's example, not the limit of the request it refused** (a scan refused at `limit: 100` still
reads `{limit: 1000}`), so choose a limit that really fits. A `peek` or `pop` refusal instead names the
count that fits (`peek({limit: N}) fits`), a sorted `find` names the sort field to page by, and a
`distinct` says to add a filter or count.

## 3. Three channels, one error type

A refusal reaches a driver in one of three ways, and a driver folds all three into its one error type
**without losing which it was**:

1. **An `ERROR` frame** (section 1).
2. **In-band `success: false` + `message`** on a successful frame. Used by:
   - `create database` and `create bucket` for a bad or over-long name, an unsupported store type, a bad
     typed-field or store-field declaration, and a typed create while a cluster member's version lacks
     typed fields;
   - `delete` of a key that does not exist: `success: false`, message `document not found` (`blob not
     found` on a blob bucket), `write_outcome: not_applied`;
   - `update` of a key that does not exist;
   - `ack`, `release` and `extend` for an `unknown` or `expired` lease: `success: false` with
     `lease_state` (`unknown` or `expired`) and a message naming the fix. It is **never**
     `write_outcome: not_applied`, because the same apply may have returned other expired leases;
   - `requeue` and `discard` for entries a bucket refuses (a heap whose live element holds the same
     `_id_`): `success: false` and `refused[{dead_id, message}]`, while the entries it did move stay
     moved.

   And one in-band **success** a driver must not mistake for a refusal: `create bucket` of a name that
   exists **with the same store type** answers `success: true`, message `bucket "b" already exists (type:
   hash)`. It is idempotent by design. A `create bucket` in a database that does not exist yet still
   succeeds and creates the database with it, and then says so: `created database "app" and bucket "b"
   (type: hash)`, so a typo in the database name does not read as a plain create. A driver passes the
   `message` through and never parses it.
3. **In-band `found: false` + `message`** on reads, pops and peeks. **A miss is a successful answer,
   never an empty frame.** The absence messages are `document not found`, `queue is empty`, `heap is
   empty`, and the blob form `… not found in …`. A `found: false` with any other message is a refusal
   (a failed read), not a miss. A verb the bucket's store type does not answer is never this channel: it is
   the one `ERROR` `INVALID_ARGUMENT` of channel 1, for every verb and type (`operations.md` section 1). `SCAN` of a bucket that
   does not exist is also in-band `found: false`, while `GET` of one is an `ERROR` `NOT_FOUND`: a driver
   presents both as the same "not found".
   `DEAD_LIST` follows the same rule: an empty list is `found: false` with **no message**; a
   `found: false` **with** a message means the read failed, and
   a driver reports it as a refusal, not as "no dead entries" (a bucket type with no dead list is an `ERROR`
   frame, never this). `peek` and an unfiltered `count` of a
   queue or heap also carry `pending`, `dead` and `expired` beside the number; they are counts, not
   errors.

Which in-band messages mean which class is pinned by the vectors; a driver classifies an in-band refusal
by the operation and the vector-pinned message, and falls back to `INVALID_ARGUMENT` with the message
verbatim.

**Leases and dead entries.** The seven lease and dead writes are `QUEUE_CLAIM`, `QUEUE_ACK`,
`QUEUE_RELEASE`, `QUEUE_EXTEND`, `DEAD_REQUEUE`, `DEAD_DISCARD` and `DEAD_RESTORE`. Their refusals:

- **A claim of an entry over the hard cap** is an `ERROR` `INVALID_ARGUMENT` (about 4.74 MiB, or a heap
  `_id_` above 8 KiB), `write_outcome: not_applied`, naming the entry and the fix `pop`. Nothing was
  taken; expired leases were still returned by the same apply. **A driver recognises it by the message's
  first two words, `claim refused`**; the code does not tell it apart, because every malformed claim
  request is an `INVALID_ARGUMENT` too. That prefix is the discriminator:
  `server/queue_claim.go:ErrClaimEntryTooLarge` is `errors.New("claim refused")`, and both of its
  sentences — the footprint one and the heap-id one — are that error wrapped, so each starts with it. No
  other claim refusal does: a claim over its limit starts `invalid claim limit`, a bad `lease_ms`
  `invalid lease`, a claim on a bucket with no order `claim is not defined for `. Match the prefix
  together with `INVALID_ARGUMENT`, and never the rest of the sentence, which names sizes and the
  bucket. A driver may give this refusal its own sentinel (the Go driver's `ErrClaimEntryTooLarge`); a
  `consume` loop treats it as terminal for good, because no claim succeeds until the entry at the front
  is popped.
- **A lease verb on an `unknown` or `expired` lease** is in-band `success: false` with `lease_state`, as
  above; nothing was acknowledged, released or extended.
- **A removed node refuses every lease and dead write a client can send** (`claim`, `ack`, `release`,
  `extend`, `requeue`, `discard`) with `write_outcome: not_applied` and the address of a member to
  connect to, exactly as it refuses `pop`.
- **`DEAD_RESTORE` is restore-only.** A client frame carrying it is refused before routing, with
  `PERMISSION_DENIED` and `write_outcome: not_applied`: `restore-only: DEAD_RESTORE is sent by a
  restore, never by a client. Run: hoarddb restore <dir>` (`server/dead_letter.go:ErrDeadRestoreOnly`).
- **A claim, ack, release, extend or dead verb on a hash, btree or blob bucket** is the wrong-type `ERROR`
  frame (`INVALID_ARGUMENT`, `write_outcome: not_applied` for the writes) naming the type and the verb that
  works (`get`/`find`/`delete`) and ending with the verbs the type takes. **Any lease or dead verb on a store
  field** is refused with the field named and the field's `pop`.

**The cap refusal has no vector row, so the `claim refused` prefix rests on a convention.**
`testdata/driver-vectors/v1.json` pins `claim limit above the maximum`, `lease without bounds`
and `claim on a hash bucket`, and none of them reaches the cap. A server rewording the sentence would
silently turn the refusal into a plain `INVALID_ARGUMENT` for every driver: a caller would lose the
statement that only `pop` unblocks the queue, though a `consume` loop would still end, because
`INVALID_ARGUMENT` is terminal either way. The row it needs, to be generated by the server (the file is
generated; `testing.md` section 1):

| Field | Value |
|---|---|
| `name` | `a claim of an entry over the hard cap` |
| `group`, `kind`, `status` | `errors`, `exchange`, `frozen`, beside `claim limit above the maximum` |
| setup | a fifo bucket holding one entry over the cap, or, for a payload a vector can carry, a heap whose element `_id_` is above 8 KiB, which takes the same refusal |
| request | `QUEUE_CLAIM` (`limit: 1`) |
| answer | an `ERROR` frame, `code: 4` (`INVALID_ARGUMENT`), `write_outcome: not_applied`, `message_contains: ["claim refused"]` |

## 4. The write outcome

Every refusal of a write says whether the write happened, on a single node as on a cluster. The writes
are the data verbs: put, insert, insert many, push, pop, delete, update, put blob, the field-store
writes, and the lease and dead writes `claim`, `ack`, `release`, `extend`, `requeue` and `discard`.
(`DEAD_RESTORE` is a write too, but a restore's own; a client frame carrying it is refused
`not_applied`.)

| `write_outcome` | Means | A caller may |
|---|---|---|
| `not_applied` | nothing was written: the request was refused before anything was applied (a bucket or database that does not exist, a permission, the document or blob limit, a request that does not decode, a duplicate key, a type or path refusal, an update its operators refuse, a field verb on a missing document) | retry it safely, though the same request fails the same way unless something changed (section 6; after a backoff, if the code says the cluster is busy) |
| `applied` | the write is stored, though the request as a whole was refused (a write-concern `TIMEOUT`). Only a write the server accepted is `applied`: one it refuses (a `$inc` of a string, a type refusal) keeps its own refusal and `not_applied` (`unknown` when the owner owes the bucket applies) even when the write-concern wait that follows times out | **not** resend a push or an increment: it would apply twice |
| `unknown` | the server cannot tell (ownership moved under the write; a forwarded write's answer was lost; the owner's own store failed the apply) | read it back before resending anything that is not idempotent |
| absent | not reported: a read, a DDL request, an older server, or a single node whose own store failed the write (its message says the store failed) | treat as unknown for a write |

A refused write with no `write_outcome` therefore comes from a server older than this rule, or from a
store failure on a single node: a commit the store reported as failed may still have reached its
memory. Either way the outcome is unknown, and a driver says so.

**A pop that removed an entry is answered success with its entry, never an error, when its write falls
short**, because the answer is the only copy of the entry. On a cluster that is a write concern not
met in time, the bucket's owner changing while the pop was in flight, or a replica refused for not
encrypting its store: the success carries `copies_confirmed` below `replication_factor` and
`write_outcome: applied`. On a single node it is a sync to disk that failed after the removal
committed: the success carries `write_outcome: applied` and no copy counts, and its message says the
removal is not yet on disk, so the entry may be served again after a restart or a power loss. In both
cases the message says what fell short. A driver returns the entry and does not retry the pop.

**A claim follows that rule for the entries it took.** A claim that took entries and whose write fell
short is answered **success with its entries, its lease id and its lease length**, `write_outcome:
applied`, and a message that says the lease and its entries are in the answer, to process and ack them as
usual. That is:

- on a cluster, a write concern not met in time or the bucket's owner changing under it, with
  `copies_confirmed` below `replication_factor` (`server/write_path.go:Cluster.answerShortfall`,
  `server/write_path.go:claimedShortMessage`);
- on a single node, a lease that committed and could not then be written to disk, with no copy counts;
  its message says the lease may not exist after a restart or a power loss, where an ack then answers
  `unknown` and the entries are delivered again (`server/ack_sync.go:writeNotDurableError.answerClaim`).

A claim that took no entry keeps the error any other write gets. With no entries in its answer, a claim
whose lease could not reach the disk is `INTERNAL` with `write_outcome: unknown`, and its message says
the entries return when the lease ends, to claim again (`server/ack_sync.go:writeNotDurableError.forClaim`);
so a `TIMEOUT` on a claim never hides an entry. A driver runs the entries it was given and does not call
that success a failure.

On a **cluster**, every data-mutation **success** also carries `copies_confirmed` and
`replication_factor`; on a single node, and on DDL, they are absent. `write_outcome: unknown` appears on
a success response only in the rare `success: false` case where the owner's own store failed.

**Write concern** (`one`, `majority`, `all`; empty means the server's configured default) is counted
over the copies that are **in sync**: an `all` write with a replica down is **answered success** with
`copies_confirmed` below `replication_factor`. Durability is a number a caller reads, not a refusal. A
write concern that cannot be met in time is `TIMEOUT` with `write_outcome: applied`, and its message
says how many copies hold the write and not to resend a push or an increment.

## 5. `UNAVAILABLE`, in detail

Each of these is answered with code `0x06`; the message says what is happening and what to do. The
`write_outcome` column is what a write carries:

| Situation | `write_outcome` | Message begins |
|---|---|---|
| a read reached a node that does not hold the bucket | (read) | `bucket "b" in database "d" is held by node <id> (cluster address <addr>) and its replicas; this node does not hold it …` |
| the cluster's membership is changing (epoch mismatch, or a node that is not the owner on its view) | `not_applied` | `the cluster's membership is changing and the write was not applied: …` |
| this node was removed from the cluster | `not_applied` | `this node was removed from the cluster at epoch N and no longer accepts writes; connect to <member> …` |
| the bucket's owner changed while the write was in flight | `unknown` | `the bucket's owner changed while the write was in flight: …` |
| a forwarded write's answer was lost | `unknown` | `the owner's answer to a forwarded request was lost: …` |
| a forwarded pop's answer was lost (fifo, lifo, heap, or a document's store field) | `unknown` | `the owner's answer to a forwarded request was lost: …`; it continues `the entry may be lost … Do not pop again to look for it. Peek to see what is left: db.<bucket>.peek() (run 'use <database>' first)`, or the field's `db.<bucket>["<key>"].<field>.peek()`; the entries are up to the pop's `limit`, so a driver words it `outcome unknown: the pop may have removed up to N entries; run peek to see what is left` and a caller reads the rest with `peek({limit: N})` |
| the owner is still copying the bucket after a membership change (a read, a write, or a create of it) | read: none; write and create: `not_applied` | `… is copying it from the bucket's other holders now …`, ending "Retry in a moment" |
| the node has not been added to its cluster yet (it serves nothing that names a database or bucket) | `not_applied` | `This node has not been added to the cluster yet: …` |
| a founder of a new cluster whose seed list names a founder that has not answered (the same state as `waiting for founders` in `health`) | `not_applied` on a write (a read carries none) | `This node is a founder of a new cluster and serves no database or bucket until every founder in its seed list has answered it; <node ids> has not answered yet. Start it, or, if it is not coming back, run 'remove-node <node-id>' for it on a running founder.` Then `Nothing was read or written.` — never the `not been added` sentence, because `join` would not help a founder |
| a cluster member's version lacks a feature the request needs | `not_applied` | names the member and the upgrade |
| an `ALTER_BUCKET` reached a cluster with a member whose version lacks the opcode | `not_applied` | names the member and the upgrade |
| an `ALTER_BUCKET` while the owner has not finished recording the last membership change (placement pass) | `not_applied` | `bucket "b" cannot change its replication_factor yet: <node> is still recording which buckets the last membership change moved … Run the alter again.` |
| an `ALTER_BUCKET` that would place a member still copying the bucket from an earlier alter | `not_applied` | names the member; retry once its copy has landed |
| an `ALTER_BUCKET` that lowers the factor while a surviving member has not shown it holds what the demoted copy holds | `not_applied` | `… cannot be lowered from replication_factor …`, names the survivor and says to run `show buckets`; nothing changes, and the retry is safe |
| an operator's `migrate` was refused because the node's disk is at or above `disk_high_water_pct` | none (DDL) | `node <id> refused to copy in bucket "b" of database "d": … is above the disk high-water mark (N% used, limit M%) … Free space on that filesystem (or raise HOARDDB_DISK_HIGH_WATER), then run 'migrate d b' on <id> …` |

There is **no machine-readable retry hint**: no field names a delay, a node or a progress figure. A
driver backs off on its own schedule (100 ms doubling to 5 s, with full jitter, is the recommendation),
bounded by the caller's deadline, and surfaces the server's message when it gives up.

**Coming, and already handled by these rules:** while a node is joining a cluster, every schema change
on the cluster (create or drop a database or bucket, restore) will be refused `UNAVAILABLE`,
`not_applied`, naming the joining node and its progress. Today only the joining node itself refuses.
Reads and writes to existing buckets carry on.

## 6. The retry table

| Answer | Retry? |
|---|---|
| `UNAVAILABLE` on a read | yes, with backoff, bounded by the caller's deadline; another node may answer (the message names the holder) |
| `UNAVAILABLE` with `write_outcome: not_applied` (an `ALTER_BUCKET` refusal included) | yes, with backoff, bounded by the caller's deadline |
| `UNAVAILABLE` on a user-administration opcode (`USER_CREATE`, `USER_ALTER`, `USER_DROP`, `USER_GRANT`, `USER_REVOKE`; no `write_outcome`, nothing was applied) | yes, with backoff, bounded by the caller's deadline, resending the same `request_id` (the server answers a repeat of an applied one with success). "Not the master" is retried against the master address its message names, not on the same node (`auth.md` section 7) |
| any answer with `write_outcome: unknown` | **never automatically**: the caller decides, after reading back |
| `TIMEOUT` (`write_outcome: applied`) | **never**: the write is stored. On a pop the entries are not the error's to carry: a pop the owner applied is answered with them as a success, so a `TIMEOUT` on a pop is the fallback case (an older server, for a pop it applied or one its handler refused), the driver says `the pop was applied or refused and its answer carried no entries: it may have removed up to N entries; run peek to see what is left`, and it never retries it. A **claim** is the same for the entries it took (section 4), so a `TIMEOUT` on a claim means nothing was taken, and a claiming loop may claim again after a backoff instead of resending the failed claim (the `consume` loop of `api-go.md` section 5.2 does) |
| `OVERLOADED` | yes, that one dial, with backoff; the pool is fine. This is the all-zero-request-ID refusal of `wire.md` section 8, sent before any request is read. An `OVERLOADED` that carries a request's own ID is not that refusal: a read is resent, a write is **not** (its outcome is unknown unless the answer says otherwise) |
| `NOT_AUTHENTICATED` | re-authenticate that connection once; then resend the request once if it is a read |
| `BATCH_TOO_LARGE` | not as sent: halve the batch and resend each half (a batch of one document that still meets it cannot be split: report it). `not_applied` (a standalone node) means nothing was written; `unknown` (a cluster owner's refusal) means a member with a larger memtable may hold it, so a queue or a generated-id batch is read back first. This is the caller's decision, never an automatic retry of an `unknown` write |
| `RESULT_TOO_LARGE` | not as sent: page smaller (a cursor halves its page size as often as needed, down to 1 document, then reports), project, or narrow the filter |
| `NOT_FOUND`, `ALREADY_EXISTS`, `PERMISSION_DENIED`, `INVALID_ARGUMENT`, `DUPLICATE_KEY`, `FIELD_TYPE`, `CONFLICT`, `UNSUPPORTED_VERSION` | **never**: the same request fails the same way |
| `INTERNAL`, `UNKNOWN(n)` | never automatically |
| the connection failed before a complete response arrived | a read: once, on a fresh connection. A write, and a `pop` (it consumes, and a pop of N may lose up to N entries): **never**; the outcome is unknown and the error says so: `outcome unknown: the pop may have removed up to N entries; run peek to see what is left`. The same rule governs `claim`, `ack`, `release`, `extend`, `requeue` and `discard`: never automatically, because a lost answer may have taken entries, acked them, returned them or moved them to the dead list. A lost **claim** costs one lease of delay; a lost **ack** costs a redelivery; neither loses an entry. An `INTERNAL` answer to one request does not lose the others in flight on its connection: the server answers them before it closes, and only a request still running a frame timeout after the error is cut off |
| an `AUTH_FAIL` | see `auth.md` sections 1, 4 and 8; never in a loop. `TOKEN_INVALID` is a revocation or an unusable token and is the password fallback of `auth.md` section 3, not the end of the session |

A retry is invisible to the caller except in the driver's aggregate statistics. A driver never retries
a write it cannot prove `not_applied`.

**Connections that survive an `ERROR` frame**: `RESULT_TOO_LARGE`; `BATCH_TOO_LARGE`; an oversize request on an
authenticated connection (`wire.md` section 2); `FIELD_TYPE`; `UNSUPPORTED_VERSION` for a bucket's
declaration; every `GET_FAST` refusal; and every handler refusal that is not followed by a close. A
driver that is unsure discards the connection; that is always safe, and costs one dial.

## 7. Errors the driver makes itself

Some failures never reach a server. Each is a sentence with three parts: what happened, what it means,
what to do. Codes for these are the driver's own (outside the wire range), and each is matchable:

| Situation | The sentence says |
|---|---|
| Server key unknown, nothing pinned | the host, the fingerprint it presented, and the three ways to trust it (pin it, trust it once with the CLI, or accept on first sight for local development) |
| Pinned or recorded key changed | both fingerprints; if the keys were rotated, which line of `known_servers` to delete; if not, that the connection may be intercepted; that the driver will not retry |
| Credentials refused | the user; that the driver does not retry; where the root password comes from (`HOARDDB_ROOT_PASSWORD`, or the one the server printed or asked for on its first start) |
| `RATE_LIMITED` | that it is not a credential failure; to wait (the driver holds 5 s, jittered, before trying again); that the driver stopped retrying |
| Unreachable | the address, the network error, and (for `localhost`) that the server listens on loopback by default and the container image on every interface |
| An option the server did not advertise | the option, the capability it needs, the server's version; that nothing was sent |
| A request over 32 MiB | the arithmetic, and the remedy (smaller batches, or a blob) |
| The caller's deadline passed | the operation and target; for a write, that the outcome is unknown and not to resend a push or an increment |
| A bad URI | the part that is wrong and the expected shape (`trust.md` section 6) |

No message or log line contains a password or a token.

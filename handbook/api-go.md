# The Go driver's API

Module `github.com/hoarddb/hoarddb-go`, package `hoarddb`, Go 1.23 or later (a floor, not a pin; the
cursor uses range-over-func). Binds the Go driver only. Every name here comes from a hoardDB concept
(the opcode, the store type, the bucket) or from a Go standard-library convention, never from another
database's driver.

The connection layer already exists: `Connect`, the options, trust, AUTH with tokens, the pool, `Ping`,
`ServerInfo`, `PoolStats` and the `Error` type, with the unstable wire package `hoarddbwire`. This
chapter is the whole v1 surface.

## 1. Shape

```
Client                one per program; a pool of connections; safe for many goroutines
 └─ Database          a name; no I/O, no resources
     └─ Bucket        a name; no I/O, no resources; every verb of every store type
         └─ FieldStore   one document's store field; no I/O, no resources
```

Rule 7 (predictable APIs): the same verb has the same name, argument order and result shape on every
type that answers it. Argument order is always `ctx`, then names from outer to inner (database, bucket,
key, element), then the document, then options. Options are small function types of this package; a
call that needs six or more inputs takes a struct.

**Handles cost nothing.** `client.Database("app").Bucket("users")` allocates two small structs, does
no I/O, holds no connection, goroutine, timer, cache entry or metric, and is registered nowhere. A
program may hold a million. The first error appears on the first operation, where it carries the fix.
The driver never looks a bucket's store type up: a verb the type does not answer is the server's
refusal, passed through.

## 2. Connecting

```go
func Connect(ctx context.Context, uri string, opts ...Option) (*Client, error) // "" reads HOARDDB_URI
func (c *Client) Close() error                      // idempotent, any goroutine
func (c *Client) Ping(ctx context.Context) error
func (c *Client) ServerInfo() ServerInfo            // version, protocol, capabilities; no round trip
func (c *Client) PoolStats() PoolStats              // aggregate; Retries counts every retry; never per bucket
func (c *Client) Health(ctx context.Context) (*Health, error)
func (c *Client) ListNodes(ctx context.Context) ([]Node, error)
```

Options (an option overrides the URI, which overrides the environment):

| Option | Default | Notes |
|---|---|---|
| `WithCredentials(user, password)` | URI, else `HOARDDB_ROOT_USER` (`admin`) and `HOARDDB_ROOT_PASSWORD` | |
| `CredentialsFromEnv()` | | the explicit spelling of the environment rule |
| `WithToken(token)` | | a resumption token, not a password (`auth.md` section 3) |
| `WithFingerprint(fp...)` | | pins, positional per host (`trust.md` section 6) |
| `WithKnownServers(path)` | `~/.hoarddb/known_servers` | the trust store the CLI writes |
| `WithTrustPrompt(func(host, fp string) bool)` | none: an unknown server is refused | |
| `AcceptFirstSight` | | a ready-made prompt for local development; logs a warning |
| `WithInsecureSkipVerify(reason)` | off | reason required; logged at WARN on every dial; not reachable from a URI |
| `WithPoolSize(n)` | 4 per host | the point lane |
| `WithBulkPoolSize(n)` | 2 per host | the bulk lane: blobs, `Find` and `Range` pages, `Search`, `Distinct`, `InsertMany` |
| `WithRequestTimeout(d)` | 30 s | applied when the `ctx` has no deadline |
| `WithDefaultWriteConcern(wc)` | the server's default | `One`, `Majority`, `All` |
| `WithClientName(name)` | | appended to `hoarddb-go/<version>` in AUTH |
| `WithLogger(*slog.Logger)` | discard | a library does not write to stderr |

There is no option that turns TLS off, and no write concern or trust bypass in a URI.

## 3. Databases and buckets

```go
func (c *Client) Database(name string) *Database
func (c *Client) DefaultDatabase() (*Database, error)   // from the URI path; the error names the missing segment
func (c *Client) DefaultBucket() (*Bucket, error)
func (c *Client) CreateDatabase(ctx context.Context, name string, opts ...CreateOption) error
func (c *Client) DropDatabase(ctx context.Context, name string) error
func (c *Client) ListDatabases(ctx context.Context) ([]DatabaseInfo, error)

func (d *Database) Name() string
func (d *Database) Bucket(name string) *Bucket
func (d *Database) Open(ctx context.Context, name string) (*Bucket, error)   // one Stats round trip; the handle's Type() is the stored type; a missing bucket or database is ErrNotFound
func (d *Database) CreateBucket(ctx context.Context, name string, kind StoreType, opts ...CreateOption) (*Bucket, error)
func (d *Database) DropBucket(ctx context.Context, name string) error
func (b *Bucket) Drop(ctx context.Context) error   // DropBucket on the handle; a missing bucket is ErrNotFound
func (b *Bucket) Type() StoreType   // set by Open and CreateBucket; empty on a handle from Database.Bucket (no I/O)
func (d *Database) ListBuckets(ctx context.Context) ([]BucketInfo, error)   // one frame, no paging: an operator call
func (d *Database) DeclareStoreFields(ctx context.Context, bucket string, stores ...StoreSpec) error
func (d *Database) AlterBucket(ctx context.Context, name string, opts AlterBucketOptions) (*AlterBucketResult, error)   // ALTER_BUCKET; opts is AlterBucketOptions{ReplicationFactor: n}

type StoreType string
const (FIFO StoreType = "fifo"; LIFO StoreType = "lifo"; Hash StoreType = "hash";
       BTree StoreType = "btree"; Heap StoreType = "heap"; Blob StoreType = "blob")

func WithIfNotExists() CreateOption                   // default off; an existing bucket of another type is still an error
func WithEncrypted() CreateOption
func WithReplicationFactor(n int) CreateOption        // needs the bucket_rf capability, else ErrUnsupportedByServer, nothing sent
func WithStores(stores ...StoreSpec) CreateOption     // store fields: StoreSpec{Name, Type StoreType, Stores []StoreSpec}
func WithIndexes(indexes ...IndexSpec) CreateOption   // IndexSpec{Fields []string, Unique bool, Name string, ExpireAfter time.Duration}; hash buckets only
func WithFieldTypes(mode TypeMode, fields ...FieldSpec) CreateOption // TypeMode: Strict, Warn, Off; FieldSpec{Name, Type string, Required bool, Members []FieldSpec, Elem *FieldSpec}
```

`CreateDatabase` of an existing name is `ErrAlreadyExists` unless `WithIfNotExists()`. `CreateBucket` of
an existing name is `ErrAlreadyExists` when the type differs (always) and when it matches without
`WithIfNotExists()` (the driver reads the server's idempotent "already exists" answer and reports it,
because rule 7 says `create` means the same everywhere). The godoc says that creating a bucket in a
database that does not exist creates the database.

### 3.1 What a bucket is declared as: `Info`

```go
// Info returns the bucket's declaration: its store type, its entry count and its top-level store
// fields, in one round trip (BUCKET_INFO). Read-only and safe to retry. Its cost does not depend on how
// many elements the store fields hold: it never walks them (use Stats for element counts). A bucket or
// database that does not exist is ErrNotFound; a caller without read permission is ErrPermissionDenied.
func (b *Bucket) Info(ctx context.Context) (*BucketDeclaration, error)

type BucketDeclaration struct {
    Name              string
    Type              StoreType        // the bucket's own store type
    Entries           int64
    Stores            []string         // the declared top-level store field names, in declaration order
    StoreFields       []StoreFieldInfo // the same fields with their engines, in the same order; empty when there are none
    ReplicationFactor int              // 0: the server sent none (not reported)
    Inherited         bool             // the bucket's replication factor comes from its database; false when absent
}

type StoreFieldInfo struct {
    Name   string
    Engine StoreType // the wire word as is: Hash, BTree, FIFO, LIFO, Heap, Blob; a word this driver does not know is passed through unchanged
}
```

`StoreFieldInfo.Engine` reuses `StoreType` because the wire's engine words are the catalog words
(`hash`, `btree`, `fifo`, `lifo`, `heap`, `blob`, no `Store` suffix): `StoreType` is a string type, so a
word added by a newer server arrives as a `StoreType` value no constant names, and is never dropped or
turned into an error. Compare with the constants for the ones you know, and treat any other as opaque.
`AlterBucket` changes the replication factor of an existing bucket (`ALTER_BUCKET`, the CLI's `alter bucket`):
`db.AlterBucket(ctx, "users", hoarddb.AlterBucketOptions{ReplicationFactor: 3})`. A bucket that does not
exist is `ErrNotFound` with the server's missing-bucket sentence, on a cluster whichever node the call reaches,
and is not retried. A refusal that a retry clears (a decrease the surviving copies have not caught up with, a
copy from an earlier alter still landing) is `ErrUnavailable` with `OutcomeNotApplied` and follows the retry
rule of section 7. A standalone node answers a raise in-band, saying there is no cluster to place a second copy
on. The vectors, not this page, are the contract (`alter bucket: ...` in `v1.json`).
`Info` lists top-level store fields only; a store nested inside an element is not listed. The wire's
`outside` member is not exposed. Like every handle verb it keeps no state: nothing is cached on the
`Bucket`, so the next `Info` asks the server again.

```go
decl, err := client.Database("app").Bucket("users").Info(ctx)
if errors.Is(err, hoarddb.ErrNotFound) {
    log.Fatal("no such bucket: create it first") // the error's own message carries the exact command
}
if err != nil {
    log.Fatal(err)
}
fmt.Printf("%s is a %s bucket with %d entries\n", decl.Name, decl.Type, decl.Entries)
for _, f := range decl.StoreFields { // label each store field of a document
    fmt.Printf("  %s: %s\n", f.Name, f.Engine)
}
```

## 4. Documents and results

```go
type Document []byte                              // one stored document: raw BSON, decoded only on request
func (d Document) Decode(into any) error
func (d Document) Lookup(path ...string) (Value, bool)
func (d Document) String() string                 // relaxed Extended JSON, for logs

type Value struct{ /* one BSON element */ }       // typed accessors: String, Int64, Float64, Bool, Time, ...
type Map = map[string]any                          // a literal document

type Receipt struct {                              // every single-document write
    ID                string                       // the key; server-assigned for Insert and Push
    Seq               uint64
    CopiesConfirmed   int                          // 0: not reported (a single node, or an older server)
    ReplicationFactor int
}
type BatchReceipt struct { IDs []string; Count int; CopiesConfirmed, ReplicationFactor int }
type Entry struct { Key string; Value Document }   // btree range, first, last
type StoredBlob struct { Key, BlobID string; Data []byte; Size int64; Metadata Document }
type BlobReceipt struct { Receipt; BlobID string; Size int64 }
```

The blob's value is `StoredBlob`, not `Blob`: `Blob` is the store-type constant of section 3, and one
package cannot give the same name to a type and a constant.

```go
// GetAs is Get then Decode: the document under key, decoded into a T (a struct with bson tags, or Map).
// A miss is ErrNotFound with the zero T; a document that does not decode into T is ErrInvalidArgument,
// naming the key and the field. A function, not a method, because Go methods take no type parameters.
func GetAs[T any](ctx context.Context, b *Bucket, key string, opts ...ReadOption) (T, error)
```

A document going in is `any`: a struct with `bson:"…"` tags, a `Map`, or a `Document` passed through
untouched. No type from the BSON library appears in any exported signature, field, godoc or example;
the codec sits behind `internal/codec` and could be replaced without an API change.

## 5. The verbs

```go
// keyed stores: hash, btree
func (b *Bucket) Put(ctx context.Context, key string, doc any, opts ...WriteOption) (Receipt, error)
func (b *Bucket) Insert(ctx context.Context, doc any, opts ...WriteOption) (Receipt, error)            // server assigns the key
func (b *Bucket) InsertMany(ctx context.Context, docs []any, opts ...WriteOption) (BatchReceipt, error)  // bulk lane
func (b *Bucket) Get(ctx context.Context, key string, opts ...ReadOption) (Document, error)            // ErrNotFound on a miss
func (b *Bucket) Exists(ctx context.Context, key string) (bool, error)
func (b *Bucket) Delete(ctx context.Context, key string, opts ...WriteOption) (bool, error)             // false: nothing was there
func (b *Bucket) Update(ctx context.Context, key string, update Update, opts ...WriteOption) (Document, error)

// queues and heaps: fifo, lifo, heap
func (b *Bucket) Push(ctx context.Context, doc any, opts ...WriteOption) (Receipt, error)              // heap: WithPriority optional; without it the element goes in at priority 0
func (b *Bucket) Pop(ctx context.Context, opts ...PopOption) ([]Document, error)                         // empty slice and nil error when nothing was removed; WithLimit(n), 1 to 100, default 1; pop order; the write options are PopOptions too
func (b *Bucket) Peek(ctx context.Context, opts ...PeekOption) ([]Document, error)                       // empty slice and nil error when empty; WithLimit(n), 1 to 1000, default 1; pop order, none removed

// leases and the dead list: fifo, lifo, heap buckets
func (b *Bucket) Claim(ctx context.Context, opts ...ClaimOption) (Claimed, error)                        // nothing to take is a Claimed with no items and a nil error; WithLimit(n), 1 to 100, default 1; WithLease(d), default 30s, 1s to 1h
func (b *Bucket) Ack(ctx context.Context, l LeaseID, opts ...AckOption) (AckResult, error)               // WithItemIDs(...), at most 100; without it, the whole lease
func (b *Bucket) Release(ctx context.Context, l LeaseID, opts ...WriteOption) (ReleaseResult, error)
func (b *Bucket) Extend(ctx context.Context, l LeaseID, d time.Duration, opts ...WriteOption) (time.Duration, error) // the granted length
func (b *Bucket) Consume(ctx context.Context, handle func(ctx context.Context, d Delivery) error, opts ...ConsumeOption) error
func (b *Bucket) DeadList(ctx context.Context, opts ...DeadListOption) (*DeadPage, error)                // WithLimit(n), After; a read
func (b *Bucket) Requeue(ctx context.Context, sel DeadSelector, opts ...WriteOption) (DeadMoveResult, error)
func (b *Bucket) Discard(ctx context.Context, sel DeadSelector, opts ...WriteOption) (DeadMoveResult, error)

type LeaseID struct{ /* unexported: the 20 bytes */ }
func (l LeaseID) String() string                     // the 40 hex characters
func ParseLeaseID(s string) (LeaseID, error)         // ack from another process, or after a restart

type LeaseState string                               // the wire's lease_state, as is
const (LeaseAcked LeaseState = "acked"; LeaseReleased LeaseState = "released"; LeaseExtended LeaseState = "extended";
       LeaseExpired LeaseState = "expired"; LeaseUnknown LeaseState = "unknown")

type Delivery struct {
    ItemID     string     // the handle for Ack: item_ids, not the document's _id_
    Document   Document   // items, in pop order
    Deliveries int        // deliveries: at least this many claims were recorded, this one included (Delivery.Deliveries godoc); 1 when absent
    // unexported: the lease, so Extend needs no lease id
}
func (d Delivery) Extend(ctx context.Context, by time.Duration) (time.Duration, error)

type Claimed struct {
    LeaseID  LeaseID
    Granted  time.Duration // lease_ms; the handler deadline is computed from it
    Items    []Delivery    // items with their item_ids and deliveries, in pop order
    Pending, Dead int64    // pending, dead: after this claim
    Returned int64         // returned: > 0 with no items means claim again at once
}

type AckResult struct {                    // QUEUE_ACK's answer
    State                   LeaseState     // lease_state
    Acked, Missing, Remaining int64        // acked, missing (named nothing the lease holds), remaining (still under it)
    Message                 string         // the server's sentence, set when the lease expired or is unknown
}

type ReleaseResult struct {                // QUEUE_RELEASE's answer
    State    LeaseState                    // lease_state
    Released int64                         // released: entries back in the queue at once
    Message  string
}

type DeadEntry struct {                    // one item of a DEAD_LIST answer
    DeadID     string                      // dead_id: the handle Requeue and Discard name, and what a page passes as after
    Document   Document                    // data
    Deliveries int                         // deliveries: how many times it was delivered before it died
    DeadAt     time.Time                   // dead_at
    Reason     string                      // reason: max_deliveries or collided
}

type DeadPage struct {                     // DEAD_LIST's answer; a read
    Items []DeadEntry                      // items, in dead-list order; empty when there are none
    Next  string                           // next: the last dead_id listed, when more remain; pass it to After
}

type Refusal struct{ DeadID, Message string }  // one refused[{dead_id, message}]

type DeadMoveResult struct {               // DEAD_REQUEUE and DEAD_DISCARD's answer
    Done, Left int64                       // done: moved; left: still on the dead list after an all request
    Refused []Refusal                      // refused: the entries that stayed, and why; those that moved stay moved
    Message string                         // the server's sentence when it refused the request
}

type DeadSelector struct{ /* unexported: one dead_id, or all with an optional after */ }
func DeadByID(deadID string) DeadSelector              // dead_id: the one entry (DeadEntry.DeadID)
func AllDead() DeadSelector                            // all: from the head; one request considers at most 100
func (s DeadSelector) After(deadID string) DeadSelector // after, exclusive, all only: steps past a refused entry

// the lease, dead and consume options
type LeaseOption struct{ /* one length */ }            // WithLease(d): a ClaimOption and a ConsumeOption
type ClaimOption interface{ /* ... */ }                // WithLimit(n) 1 to 100 (1), WithLease(d) (30s), every WriteOption
type AckOption interface{ /* ... */ }                  // WithItemIDs(...) at most 100, every WriteOption
func WithItemIDs(itemIDs ...string) AckOption          // without it an ack settles the whole lease
type ConsumeOption interface{ /* ... */ }              // WithLimit(n) 1 to 100 (10), WithLease(d) (30s)
type DeadListOption interface{ /* ... */ }             // WithLimit(n) 1 to 1000 (10), After(deadID)
type LimitOption struct{ /* one count */ }             // WithLimit(n): a PeekOption, PopOption, ClaimOption, ConsumeOption and DeadListOption
func WithLimit(n int) LimitOption                      // the range is the verb's: 1 to 100 for pop, claim and consume; 1 to 1000 for peek and the dead list
func WithLease(length time.Duration) LeaseOption       // 1s to 1h; outside it an ErrInvalidArgument and nothing is sent

// btree
type Bounds struct{ Gte, Lte string }                                                                   // an empty side is open
func (b *Bucket) Range(ctx context.Context, bounds Bounds, opts ...FindOption) (*Cursor, error)
func (b *Bucket) First(ctx context.Context) (Entry, error)                                              // ErrNotFound on an empty tree
func (b *Bucket) Last(ctx context.Context) (Entry, error)                                               // ErrNotFound on an empty tree

// blob
func (b *Bucket) PutBlob(ctx context.Context, key string, data []byte, opts ...BlobOption) (BlobReceipt, error) // WithMetadata(doc); bulk lane
func (b *Bucket) GetBlob(ctx context.Context, key string) (*StoredBlob, error)                        // ErrNotFound; the value is StoredBlob, not Blob (section 4)

// every type that answers them
func (b *Bucket) Find(ctx context.Context, filter any, opts ...FindOption) (*Cursor, error)            // SCAN; bulk lane
func (b *Bucket) FindOne(ctx context.Context, filter any, opts ...FindOption) (Document, error)   // one SCAN with limit 1; Skip, SortBy and Projection apply; no match is ErrNotFound
func (b *Bucket) Count(ctx context.Context, filter any) (int64, error)
func (b *Bucket) Distinct(ctx context.Context, field string, filter any) ([]Value, error)
func (b *Bucket) Search(ctx context.Context, filter any, opts ...FindOption) (*Cursor, error)          // indexed; hash buckets
func (b *Bucket) Stats(ctx context.Context) (*BucketStats, error)

func WithWriteConcern(wc WriteConcern) WriteOption   // overrides the client default for one call; any write
func WithPriority(p int64) WriteOption               // heap Push only; on any other verb an ErrInvalidArgument, not a silent drop
func Consistent() ReadOption                         // Get through CONSISTENT_GET; needs consistent_get
func Limit(n int) FindOption
func Skip(n int) FindOption
func SortBy(field string, dir Direction) FindOption  // one field; Ascending, Descending
func Projection(fields ...string) FindOption
func PageSize(n int) FindOption                      // default 100: the size of one SCAN

type Update struct {                                 // all nine operators are documented (operations.md) and pinned by the shared wire vectors
    Set      Map
    Unset    []string
    Inc      map[string]int64
    Push, AddToSet, Min, Max Map
    Mul      map[string]float64
    Rename   map[string]string
}
```

**Options.** Two are shared by several verbs and the rest belong to one: `WithLimit(n)` is the count of
`Peek`, `Pop`, `Claim`, `Consume` and `DeadList`, and `WithWriteConcern(wc)` is a `WriteOption` and so
also a `PopOption`, a `ClaimOption`, an `AckOption` and a `BlobOption` — that is how a concern reaches a
verb that consumes an entry and a blob write. `Consistent()` is a `ReadOption`, `WithPriority(p)` a
`WriteOption` only a heap `Push` accepts, and `WithMetadata(doc)` a `BlobOption` alone. A count or a
lease length outside its range is `ErrInvalidArgument` and nothing is sent.

**Each field is a wire member.** The names below are `operations.md`'s; the field is a Go spelling of the
same member, and no result type carries a number the server did not send.

| Verb | Wire members | Go fields |
|---|---|---|
| `claim` | `found, items[], item_ids[], deliveries[], lease_id, lease_ms, pending, dead, returned` | `Claimed.Items[].Document`, `.ItemID`, `.Deliveries`; `Claimed.LeaseID`, `.Granted`, `.Pending`, `.Dead`, `.Returned` |
| `ack` | `success, lease_state, acked, missing, remaining, message` | `AckResult.State`, `.Acked`, `.Missing`, `.Remaining`, `.Message` |
| `release` | `success, lease_state, released, message` | `ReleaseResult.State`, `.Released`, `.Message` |
| `extend` | `success, lease_state, lease_ms, lease_deadline, message` | the returned `time.Duration`, from `lease_ms` |
| `dead` | `found, items[{dead_id, data, deliveries, dead_at, reason}], next` | `DeadPage.Items` (`DeadEntry{DeadID, Document, Deliveries, DeadAt, Reason}`), `.Next` |
| `requeue`, `discard` | `success, done, left, refused[{dead_id, message}], message` | `DeadMoveResult.Done`, `.Left`, `.Refused` (`[]Refusal{{DeadID, Message}}`), `.Message` |

- `item_ids` is parallel to `items` and `deliveries` is parallel to both; `deliveries` is absent when
  every value is 1, so an absent delivery count is 1. `items` are documents in pop order, and an
  `item_ids` entry is a handle, not a document's `_id_`.
- `lease_deadline` is on the wire and is not exposed: a handler deadline is computed from `Granted` and
  the process's own monotonic clock (section 5.2), because the server's clock and the caller's differ.
  `granted`/`lease_ms` is the length, which is the same number on both clocks.
- `lease_state` is one of `acked`, `released`, `extended`, `expired`, `unknown`, and it is a `LeaseState`
  (a string type), so a word a newer server adds arrives unchanged instead of failing the call. An
  `expired` or `unknown` state is an in-band `success: false` (`errors.md` section 3): the result comes
  back beside `ErrLeaseExpired` or `ErrLeaseUnknown`, so the counts stay readable and `errors.Is` works.
- `write_outcome`, `copies_confirmed` and `replication_factor` on these six frames are the write outcome
  of `errors.md` section 4; these result types do not repeat them (`Receipt` and `BatchReceipt` are the
  only types with copy counts). A claim that took entries is answered success even when its write
  concern fell short, exactly as a pop is, so `Granted` and the items are never lost to a `TIMEOUT`.
- `dead_id` is `DeadByID`'s member and `all` and `after` are `AllDead`'s and `DeadSelector.After`'s. An
  `after` without `all`, and an `after` that is not a dead id, are `INVALID_ARGUMENT`.
- `Pop` takes `PopOption`s, which include the write options, because a pop consumes: it is a write, it
  carries a write concern, and it is **never retried**. `WithLimit(n)` (1 to 100, default 1) removes and
  returns up to `n` entries in one request, in pop order, so the answer is a list; an empty slice and a nil
  error when nothing was removed (a list verb never reports an empty result as an error, in any driver). A field pop does not expose an element's position, priority or entry id, as a field `Peek`
  does not.
- **`Claim` and `Ack` are the lossless pair.** `Claim` takes entries under a lease and leaves them in the
  store; `Ack` removes the ones named. `Claim` returns a `Claimed` with no items and a nil error when
  there was nothing to take (`found: false`, `returned == 0`); a claim that returned expired leases and took
  nothing is the same shape with `Returned > 0`, so `Consume` knows to claim again at once. `AckResult`
  and `ReleaseResult` carry the lease's `LeaseState`; an `unknown` or `expired` state is also returned as
  a typed error (`ErrLeaseUnknown`, `ErrLeaseExpired`) wrapping the result, so `errors.Is` works and the
  counts stay readable. `DeadList` is a **read**; `Requeue` and `Discard` are writes.
- `Delete` returns `false, nil` for a key that was not there (the server's `success: false`,
  `not_applied`); repeating a delete is safe.
- **A miss on a single-value verb is `ErrNotFound`** (`Get`, `GetBlob`, a field `Get`, `First`, `Last`), so a miss
  and a stored null are never confused; there is no separate "empty" error. A list verb (`Pop`, `Peek`,
  `Claim`, their field forms, `DeadList`) never returns either: empty is an empty result and a nil error.
- `Get` with `Consistent()` reads every copy and is the read-your-writes verb on a cluster.
- **How a write concern reaches a blob write.** `BlobOption` is an interface that every `WriteOption`
  satisfies, so `WithWriteConcern(wc)` applies to `PutBlob` on a bucket and on a field store exactly as
  it applies to `Put`, and the client's default write concern applies when the call names none.
  `WithMetadata` is the one option that is a blob's alone.

### 5.1 The cursor

```go
type Cursor struct{ /* unexported */ }
func (c *Cursor) Next(ctx context.Context) bool      // fetches the next page when the current one is spent
func (c *Cursor) Document() Document                 // valid until the next call to Next
func (c *Cursor) Err() error
func (c *Cursor) Close() error                       // releases nothing on the server today
func (c *Cursor) Total() int64                       // from the first page: for Find the exact match count; for Search the number returned (see has_more in operations.md)
func (c *Cursor) All(ctx context.Context) ([]Document, error)
func (c *Cursor) Documents(ctx context.Context) iter.Seq2[Document, error]
```

The godoc says plainly: **a cursor is not a snapshot** (`operations.md` section 3). On
`RESULT_TOO_LARGE` the cursor halves its page size and retries, as often as needed (at most
log2(`PageSize`)+1 attempts per page, down to 1 document). A page size that worked is kept for later
pages, and a later page may halve again. If a single document still exceeds the ceiling, the cursor
returns the error with both numbers.

### 5.2 `consume`, the loop

`Consume` claims up to `limit` (default 10) for `lease` (default 30 s), runs the handler for every
`Delivery`, and acks each entry whose handler returned `nil`. It acks a batch when every handler has
returned or the handler deadline has passed (whichever comes first), so one slow handler cannot hold
back the entries that finished. The handler deadline is computed from the driver's monotonic clock, not
from `lease_deadline`. A handler that needs longer calls `d.Extend(ctx, by)`, which extends the whole
lease; `Consume` moves the batch's deadline to match. On cancellation it releases what it has not acked.
A failed or panicking handler is not acked, so its entry expires and is redelivered.

An empty claim backs off (100 ms doubling to 5 s, full jitter); a claim that took nothing but returned
entries claims again at once. `RESULT_TOO_LARGE` does not arise for a claim: it stops short.

**What `Consume` does with a failed claim or ack.** Delivery is
at-least-once, so claiming again is always safe: an entry under a lease nobody acked comes back when
the lease ends, and a claim whose answer was lost took either nothing or a lease that will end. The
split is therefore by whether anything a person must do could cure the refusal, never by the write
outcome. `Consume` backs off on its own schedule (`errors.md` section 5) and issues a **new** claim; it
never resends the claim or the ack whose answer was lost, which is what keeps `errors.md` section 6's
rule for writes intact.

- **Back off and continue:**
  - `UNAVAILABLE` on a claim, including a **lost connection** (the connection failed before an answer
    arrived). Another node or a later moment may answer, and the outcome leaves nothing to lose: with
    `not_applied` the claim took nothing, and with `unknown` — the bucket's owner changed under it, a
    forwarded answer was lost, or no answer came — anything it took is under a lease that ends, and its
    entries are delivered again then. `errors.md` section 6 never resends an `unknown` write; claiming
    again is not resending that claim;
  - `TIMEOUT` on a claim. A claim that took entries is never answered `TIMEOUT`: like a pop, it is
    answered success with its entries, `write_outcome: applied` and `copies_confirmed` short of
    `replication_factor` (`errors.md` section 4), and `Consume` runs those entries and does not claim
    them again. So a `TIMEOUT` means this claim took nothing — it may have returned expired leases —
    and claiming again is safe. `errors.md` section 6 refuses to resend a write on `TIMEOUT`; this loop
    is the exception its own contract earns, and a redelivery is the only cost;
  - `OVERLOADED` on a claim: this is the connection-level refusal of `wire.md` section 8, sent before any
    request is read, so nothing was applied and the pool's open connections are fine;
  - the same three on an **ack** — `UNAVAILABLE` (its answer was lost or its connection went), `TIMEOUT`,
    `OVERLOADED`. An ack that was not answered either removed what it named, in which case the next
    claim does not see those entries, or did not, in which case they are delivered again;
  - an **ack of an expired or unknown lease**, `ErrLeaseExpired` or `ErrLeaseUnknown` (the in-band
    `success: false` of `errors.md` section 3). Nothing was acknowledged: the entries are back in the
    queue, or were never under that lease, and the next claim finds them.
- **End `Consume`, returning the error:**
  - `INVALID_ARGUMENT` on a claim, in every shape: `ErrClaimEntryTooLarge` (the entry at the front is
    over the hard cap — the refusal whose message starts `claim refused`, `errors.md` section 3 — so no
    claim succeeds until it is popped), a `WithLimit` or `WithLease` outside
    its bounds (the driver refuses it before sending anything), and a claim on a bucket whose store
    type has no order (a hash, btree or blob bucket). The same request fails the same way for as long as
    the caller does nothing;
  - `PERMISSION_DENIED`: the grants do not cover the bucket, and claiming again does not change them;
  - not found: the bucket or its database does not exist (`ErrNotFound`), and the message names the fix;
  - `INTERNAL`, and any code this driver does not know (`UNKNOWN(n)`): the server's own failure, not a
    busy cluster. One `INTERNAL` a claim can answer is a lease that committed and could not be written to
    disk, `write_outcome: unknown`, whose message says to claim again (`errors.md` section 4); this loop
    still ends, as this list says, and a caller that wants to ride that event out calls `Claim` itself;
  - the `queue_claim` member-feature refusal (`ErrUnsupportedByServer`): a cluster member's build lacks
    the verbs, so the handler would never run and only an upgrade cures it;
  - any other error, including an error the driver makes itself;
  - the caller's context ending: `Consume` releases what it has not acknowledged, under a short deadline
    of its own, and returns an error that wraps the context's (`CodeInterrupted`).

`errors.md` section 6's table governs each individual call; these two lists are `Consume`'s policy on
top of it, and a driver implements them once instead of deriving them call by call.

## 6. Store fields

```go
func (b *Bucket) Field(key, field string) *FieldStore         // document key, field name; no I/O
func (f *FieldStore) Field(element, field string) *FieldStore // a store nested inside an element (the wire's path)

func (f *FieldStore) Push(ctx context.Context, doc any, opts ...WriteOption) (Receipt, error)   // fifo, lifo, heap
func (f *FieldStore) Pop(ctx context.Context, opts ...PopOption) ([]Document, error)             // empty slice and nil error when empty; WithLimit(n), 1 to 100, as for a bucket
func (f *FieldStore) Peek(ctx context.Context, opts ...PeekOption) ([]Document, error)          // empty slice and nil error when empty; WithLimit(n), as for a bucket
func (f *FieldStore) Put(ctx context.Context, element string, doc any, opts ...WriteOption) (Receipt, error) // hash, btree
func (f *FieldStore) Get(ctx context.Context, element string) (Document, error)                 // ErrNotFound
func (f *FieldStore) Delete(ctx context.Context, element string, opts ...WriteOption) (bool, error)
func (f *FieldStore) PutBlob(ctx context.Context, element string, data []byte, opts ...BlobOption) (BlobReceipt, error)
func (f *FieldStore) GetBlob(ctx context.Context, element string) (*StoredBlob, error)
func (f *FieldStore) Len(ctx context.Context) (int64, error)
func (f *FieldStore) List(ctx context.Context, opts ...FindOption) (*Cursor, error)             // FIELD_LIST pages; PageSize up to 1,000
```

The verbs and their meanings are the bucket's (rule 7): `users.Field("ada", "Purchases").Push(ctx,
order)` pushes onto Ada's own purchase queue exactly as `queue.Push(ctx, order)` pushes onto a fifo
bucket. A nested store is reached through the element that holds it: `users.Field("ada",
"Recipes").Field("pie", "Steps")`. An undeclared field or a missing parent document is `ErrNotFound`.

**`len` is a count on `FIELD_LEN` only.** Every field answer except `FIELD_LIST` carries `len`, and
only `Len` fills it; on a push, pop, peek, put, get or delete it arrives as 0, and a 0 there does not
mean the field is empty. A driver that needs the count sends `Len` (the vectors pin the 0 on every
store-field row).

## 7. Errors

`*hoarddb.Error` is the one error type every call returns (it exists; this adds the write outcome):

```go
type Error struct {
    Code    Code         // a wire code 0x01..0x10, or a driver code from 0x100
    Op      string       // "put", "find", "connect", ...
    Target  string       // "app/users/ada", or a host for a connection error
    Message string       // the server's sentence verbatim, or the driver's with its fix; never a secret
    Reason  AuthReason   // for ErrAuthFailed
    Outcome WriteOutcome // OutcomeNotReported, OutcomeApplied, OutcomeNotApplied, OutcomeUnknown
    CopiesConfirmed, ReplicationFactor int
    MaxResultBytes, RetainedBytes      int64 // for ErrResultTooLarge
    Err     error        // the cause: a network error, context.DeadlineExceeded
}
```

Sentinels, matched with `errors.Is`: `ErrNotFound`, `ErrAlreadyExists`,
`ErrPermissionDenied`, `ErrInvalidArgument`, `ErrInternal`, `ErrUnavailable`, `ErrTimeout`, `ErrConflict`,
`ErrQuotaExceeded`, `ErrUnsupportedVersion`, `ErrNotAuthenticated`, `ErrOverloaded`, `ErrResultTooLarge`,
`ErrDuplicateKey`, `ErrFieldType`, `ErrLeaseUnknown`, `ErrLeaseExpired`, `ErrClaimEntryTooLarge`; the
driver's own: `ErrAuthFailed`, `ErrUntrustedServer`,
`ErrServerKeyChanged`, `ErrFingerprintMismatch`, `ErrInvalidURI`, `ErrUnsupportedByServer`,
`ErrClosed`, `ErrUnreachable`. An unknown wire code keeps its number and matches `ErrInternal`.
The driver's own failures carry a code of its own, from `0x100`: `CodeInterrupted` is the caller's
deadline passing or their context being cancelled, and that error also matches
`context.DeadlineExceeded` (or `context.Canceled`), so a caller can test either way. The server's own
`TIMEOUT` is `ErrTimeout`, a different thing.

In-band refusals (`errors.md` section 3) become the same `*Error`, classed by the vector-pinned
message, else `ErrInvalidArgument`; a miss on a single-value verb (`Get`, a field `Get`, `GetBlob`, and `First`/`Last` of an empty tree) is `ErrNotFound`, and on `Pop`/`Peek`/`Claim` and `DeadList` an empty
result is not an error (an empty slice, a `Claimed` or `DeadPage` with no items).

**Retries** follow `errors.md` section 6 exactly. In Go terms: `Get`, `Exists`, `Find`, `FindOne` and `Search`
pages, `Count`, `Distinct`, `Range`, `First`, `Last`, `Peek`, `Stats`, `Info`, `Open`, `Len`, `List`, the list calls,
`Ping` and `Health` are retried once on a fresh connection after a connection failure; `UNAVAILABLE`
on a read, and `UNAVAILABLE` with `OutcomeNotApplied`, is retried with backoff within the caller's
deadline; nothing else is retried, however its outcome reads — an `INVALID_ARGUMENT` with
`OutcomeNotApplied` (the unknown-write-concern vector is one) is refused for good, as `errors.md`
section 6 says. And these are never retried: `Put`, `Insert`, `InsertMany`, `Push`, `Pop`, `Update`,
`Delete`, `Drop`, `PutBlob`, `Claim`, `Ack`, `Release`, `Extend`, `Requeue` or `Discard`, or a login on an unknown
outcome — a `Consume` loop issues a **new** claim after a backoff rather than resending one (section 5.2).
`DeadList` is a read and follows the read rule. A cancelled or timed-out write returns
`OutcomeUnknown`, and its message says not to resend a push or an increment. On a `Pop` the message is
`outcome unknown: the pop may have removed up to N entries; run peek to see what is left`, with N the
`WithLimit` (1 when none), and a `Pop` answered `TIMEOUT` or another error with `OutcomeApplied` says
`the pop was applied or refused and its answer carried no entries: it may have removed up to N entries; run
peek to see what is left`. The driver never splits a `Pop` into single pops or joins single pops into one.
A retry is invisible to the caller except in `PoolStats.Retries`, which counts every retry a call made
under `errors.md` section 6; the rest of `PoolStats` is the pool's own counters, and none of it is per
bucket.

## 8. Concurrency and the pool

A `*Client` is safe for concurrent use. Two lanes per host (point 4, bulk 2), dialled lazily; a call
that finds its lane busy waits for its `ctx`. One request in flight per connection in v1; each
connection is a request-ID demultiplexer with one reader goroutine, so the pool notices a closed
connection before it is used. Idle connections are closed after 120 s, or kept alive with `PING` at
60 s. Cancelling a call closes the connection it was using (the server cannot be told to stop), and the
pool redials. Dial backoff is 100 ms doubling to 5 s with full jitter, per host; `OVERLOADED` backs off
that dial only; a trust failure is not retried. `Close` waits for every goroutine the client started.

## 9. Not in v1

`GET_FAST` as an API (the driver may use it inside `Get`); caller-visible pipelining (waits for the
server's `query_pipelining`); user administration, backup and restore, and cluster operations (the
unstable `hoarddbwire` layer can send them; the public API does not); routing by the ring (a driver
talks to any node); an ORM or a query builder.

## 10. `hoarddbwire`: the unstable layer

`github.com/hoarddb/hoarddb-go/hoarddbwire` holds the frame codec, the opcode and error tables, the
trust sub-package, `Conn` (`Dial`, `Do`, `RoundTrip`) and **one request and one response type per
opcode, with an explicit `bson` tag on every field**, equal to the wire names in `operations.md`. It
carries **no stability promise** except the frame layout and the numeric opcode and error values; its
godoc says so on its first line. A test fails if any exported identifier of the public package mentions
a `hoarddbwire` type or a BSON-library type.

# Authentication

The first frame on every connection. Language-neutral; binds every driver.

## 1. The exchange

After TLS, the driver sends `AUTH` (`0x01`) with this BSON payload:

| Field | Type | Meaning |
|---|---|---|
| `username` | string | the user |
| `password` | string | the password; ignored when `token` is non-empty |
| `protocol_version` | integer | `1`, the protocol major (the ALPN `hoarddb/1`) |
| `capabilities` | array of strings | what the client supports; send `[]` today. **Never send `pipeline_window=<n>`**: it was never implemented. Unknown strings are ignored by the server |
| `client` | string | the driver's name and version, for the server's logs: `hoarddb-go/<version>`, `hoarddb-node/<version>`; a program may append its own name (the URI's `clientName`) |
| `token` | string, optional | a resumption token (section 3); when present, the password in the same frame is ignored |

**Success** is `AUTH_OK` (`0x02`):

| Field | Type | Meaning |
|---|---|---|
| `success` | bool | `true` |
| `token` | string | a resumption token, when the server has the `auth_token` capability |
| `message` | string | human text |
| `token_expires_at` | integer, Unix seconds | when this token expires |
| `token_deadline` | integer, Unix seconds | when the chain of refreshed tokens ends; never extended by a refresh |
| `protocol_version` | integer | the server's protocol major |
| `server_version` | string | the server's version |
| `capabilities` | array of strings | `wire.md` section 6 |
| `password_min_length` | integer | the server's shortest accepted new password, in characters (section 5) |

**Failure** is `AUTH_FAIL` (`0x03`) with `{reason (integer), message (string, optional)}`. An **empty**
`AUTH_FAIL` payload, which older servers send, is read as `CREDENTIALS`; zero is not a valid reason.

| `reason` | Name | What the driver does |
|---|---|---|
| 1 | `CREDENTIALS` | stop. Never retry the same password. The error says which user and that the driver does not retry |
| 2 | `TOKEN_EXPIRED` | fall back to the password, **once**, on a **new** connection |
| 3 | `TOKEN_INVALID` | same as 2 |
| 4 | `TOKEN_UNSUPPORTED` | the server has no tokens: discard tokens and use the password |
| 5 | `PROTOCOL_MISMATCH` | stop; the message names both versions; the error names the upgrade to do |
| 6 | `RATE_LIMITED` | back off; **no credential was checked**; do not loop (section 4) |
| 7 | `ALREADY_AUTHED` | a second password AUTH on a connection that used its one (section 2): a driver bug, or a retry on the same connection |
| 8 | `INTERNAL` | a server-side failure, or a node that has not yet received its user configuration, or a cluster follower whose copy of it is too old. Not a credential failure: retryable on another node or after a short wait |

The message is passed to the caller verbatim; the driver adds what happened and what to do, and never
a password or token.

## 2. One password attempt per connection

The server claims a connection's single password AUTH **before** it checks the password, so a failed
password AUTH spends it: a second password AUTH on the same connection is refused `ALREADY_AUTHED`.
**After any failed password AUTH, a driver closes the connection and dials a new one** if it tries
again at all. The one exception is the busy refusal that checked no credential (`RATE_LIMITED` issued
by the server's derivation gate), which gives the claim back.

A token AUTH is exempt: it may be sent on an already authenticated connection, which is how a
connection refreshes its token.

## 3. Tokens

A token is a **resumption credential**: minted by a successful password AUTH, presented only in
`AUTH.token` (never per request), and accepted on another connection to the same server. A token a
node does not accept (for example after failing over to another host) is answered `TOKEN_INVALID`,
which the fallback below handles. Integers here, as everywhere, are decoded at any width (`wire.md` section 3). Two lifetimes:

- `token_expires_at`: the token's own expiry (900 s by default).
- `token_deadline`: the end of the refresh chain (12 hours by default, jittered ±10 % per chain). A
  refresh returns a new token with a new `token_expires_at` and the **same** `token_deadline`.

A driver:

1. keeps the password in memory only as long as it may need it again (it will, at `token_deadline`);
2. after the first password AUTH, presents the **token**, not the password, on every new connection, so
   the server does not repeat a deliberately slow password verification for each connection a pool opens;
3. refreshes at **half** of the token's lifetime, with **one refresh in flight per client**
   (single-flight), by sending a token AUTH on a connection it already holds;
4. when `token_deadline` has passed, or the server answers `TOKEN_EXPIRED` / `TOKEN_INVALID`, falls back
   to the password **once**, staggering the fallback with jitter so a pool of connections does not
   stampede (see "What 'once' is scoped to" below);
5. ignores the token entirely when `capabilities` lacks `auth_token`.

**What "once" is scoped to.** One password login is in flight **per client, per host** at a time, not
one per connection. A pool that loses its token does not send a password AUTH on each of its
connections: the first connection that needs to re-authenticate takes the client's single login slot,
and every other connection waits for the token that login returns and resumes with it. The token is
accepted on another connection to the same server, which is what makes the wait work. The password
AUTH frame itself is unchanged: this is the driver's own serialisation, not a wire rule.

Why it matters: the server derives Argon2 under a process-wide slot budget (its `auth_max_derivations`,
`GOMAXPROCS` by default) and a login that cannot get a slot within five seconds is refused
`RATE_LIMITED`; every password AUTH also spends one of the connection's single attempts (section 2). A
pool of eight connections logging in at once spends eight derivations and can trip the per-address
failed-login limiter on one wrong password. The one exception is a `RATE_LIMITED` refusal that checked
no credential: the connection may retry the same AUTH after a backoff, which is what section 4's
figure is for.

A token is not an API key: it expires and is minted by a password. A driver offers no "API key"
option. A token supplied by the program (the URI's `authToken`, or an option) is used for the first
connection and refreshed like any other.

## 4. The failed-login limiter

The server counts consecutive authentication failures **per source address**:

- from the 5th failure, the next attempt is delayed 1 s, doubling per failure to a cap of 30 s;
- at 20 failures (operator-tunable; 0 disables the limiter) the address is refused outright for 60 s with
  `RATE_LIMITED`, and the connection is closed (the refusal's message says so: `The server is closing
  this connection; wait out the window, then reconnect and retry with the correct password.`; the busy
  refusal, which keeps the connection open, does not);
- the count is forgotten after 15 minutes without a failure, and cleared by a successful password AUTH;
- wrong passwords, unknown users and rejected tokens count; a `RATE_LIMITED` refusal does not.

A driver's own hold after a `RATE_LIMITED` refusal is **5 seconds, with jitter**, before it tries again
(at all). That is the handbook's rule for every driver, so two of them behave
alike against one server. The server names no figure and will not: its refusal says only "a jittered
backoff".
The refusal already says which refusal it is: the ledger's text names the failure count and the 60 s
window, and the derivation gate's text says the password was not checked and lists what ends the storm
(pooled connections, a session token, or a higher `HOARDDB_AUTH_MAX_DERIVATIONS`). A driver reports
that message and waits out the hold; it does not shorten the hold because its own deadline is shorter
— it reports the refusal when the deadline expires instead.

**A driver never retries a failed AUTH in a loop**, and never retries `CREDENTIALS`, `RATE_LIMITED` or
`PROTOCOL_MISMATCH` at all. A failed login in a loop is the credential-stuffing pattern the limiter
exists to stop, and it locks out every other process on the same machine. For the same reason, a test
suite that exercises failed logins runs them against **its own server**, never one shared with other
tests.

**What "never retries at all" is scoped to.** The rule is about **the credential and the host that
answered**, not about the client process. Nothing in a refusal ends the client, and a driver does not
tear its pool down because one AUTH was refused.

- **`CREDENTIALS` is never transient.** The server compares the supplied password against the stored
  credential and answers one sentence, `invalid username or password`, for a wrong password, an unknown
  user and a disabled user, and it answers the same way when the account's stored credential names key
  material this node no longer holds (the server-side reason stays in its log). A follower whose copy of
  the user configuration lags does **not** answer `CREDENTIALS` for a password the master already
  replaced: it either verifies against the copy it has (and refuses the old password exactly as the
  master would) or, past the staleness bound, answers `INTERNAL` (below). So a driver never re-sends a
  password it was told is wrong: not on this host, not on another, not after a wait. The one password
  this must not block is a **new** one: after the program changes a password, the client discards the
  old token and authenticates with the new password on a fresh connection.
- **`PROTOCOL_MISMATCH` is per host and per attempt, not per client.** The server names both versions
  (`server speaks protocol N, client sent M`) before any credential work. A driver fails **that host**
  with an error naming the upgrade, and keeps serving the other hosts of the pool: during a rolling
  upgrade one old node must not take every connection down with it. Only a single-host client has
  nothing left to talk to, and then the error the caller sees is that host's. A driver never retries
  the same host with the same protocol major, because the answer cannot change until one side is
  upgraded.
- **`RATE_LIMITED` is a wait, not a failure.** It asserts that no credential was checked. The per-address
  ledger's refusal (20 consecutive failures, tunable by `HOARDDB_TCP_AUTH_MAX_FAILS`) closes the
  connection, so the retry is a new dial after the back-off above; the derivation-gate refusal
  (`password was not checked: the server waited … for a free password-hashing slot`) leaves the
  connection open and gives back the connection's one password attempt, so the same connection may
  re-send the same AUTH. Neither is a credential failure and neither is retried in a loop.
- **`INTERNAL` is the one retryable refusal**, and only on another node or after a wait: it covers a
  node that has not yet received its user configuration and a follower past
  `auth_config_max_staleness_seconds` (300 s by default), both of which carry a message saying so. A
  driver may retry it, bounded by the caller's deadline, preferably on another host; it never retries it
  against the same host in a tight loop.
- **`TOKEN_EXPIRED` / `TOKEN_INVALID` / `TOKEN_UNSUPPORTED`** are the fallback of section 3, not a retry
  of a failed login: they are answered once, by falling back to the password on a new connection, and
  a second refusal of that password is `CREDENTIALS`, which ends it.

## 5. Users and roles

Every user holds grants of `{role, database}`. Roles: `reader`, `writer`, `db-manager`, `user-manager`,
`cluster-manager`, `backup-operator`, `restore-operator`, `root`. Every request is checked against the user's grants before
it runs; a refusal is `PERMISSION_DENIED` (`0x03`) with a message of the form `permission denied: user
"<user>" lacks "<action>" on "<resource>"`, followed by the user's roles and the `grant role …`
command an administrator would run. A driver's documentation says a refused call is a **role** problem,
never that every user is an administrator.

The root user exists from the first start: `admin` by default (`HOARDDB_ROOT_USER`), with the password
from `HOARDDB_ROOT_PASSWORD` (or the file named by `HOARDDB_ROOT_PASSWORD_FILE`); when neither is set on
a first start from a terminal the server asks for one, and a first start with no terminal refuses,
writes nothing and says to set one. Only the password's hash is stored; the password is never written to disk,
so a driver's tests supply `HOARDDB_ROOT_PASSWORD` rather than read it back.

When a user is dropped or disabled, the server closes that user's live connections (`wire.md`
section 8).

A driver that offers user administration derives the Argon2id credential itself and sends only that, so
the server never sees the new password and cannot measure it; section 6.2 gives the derivation, the
payloads and the policy the driver applies.

## 6. User administration: the seven opcodes

A driver that offers user administration sends `USER_CREATE` (`0xB5`), `USER_ALTER` (`0xB6`),
`USER_DROP` (`0xB7`), `USER_LIST` (`0xB8`), `USER_GET` (`0xB9`), `USER_GRANT` (`0xBA`) or
`USER_REVOKE` (`0xBB`). Every field name below is exact (`wire.md` section 3) and every integer is
decoded at any width. A request carries **no plaintext password**: the driver derives the credential
itself (section 6.2) and sends only the derived material.

### 6.1 The payloads

A **grant** is one `{role, db}` pair: `role` is one of the eight role names of section 5 and `db` is a
database name or `*`. Both are strings and both are required.

| Request | Fields |
|---|---|
| `USER_CREATE` | `request_id` string, `username` string, `credentials` credential document, `roles` array of grants, `enabled` bool (optional; absent means `true`) |
| `USER_ALTER` | `request_id` string, `username` string, `version` integer, `roles` array of grants (optional), `enabled` bool (optional), `credentials` credential document (optional) |
| `USER_DROP` | `request_id` string, `username` string |
| `USER_LIST` | none: send an empty payload |
| `USER_GET` | `username` string |
| `USER_GRANT` | `request_id` string, `username` string, `role` grant |
| `USER_REVOKE` | `request_id` string, `username` string, `role` grant |

`request_id` is a UUIDv4 the driver generates per mutation (create, alter, drop, grant, revoke); the
master remembers an applied one for ten minutes and answers a repeat with success, which is what makes
the retry in section 7 safe. `USER_LIST` and `USER_GET` carry none: they change nothing.

A **credential** document is four fields:

| Field | Type | Meaning |
|---|---|---|
| `algo` | string | exactly `"argon2id"`; no other value is accepted |
| `salt` | string | the salt, **standard base64 with padding** (`A–Z a–z 0–9 + /` and `=`) |
| `hash` | string | the Argon2id output, **standard base64 with padding** |
| `params` | document | `memory`, `iterations`, `parallelism`, `salt_len`, `hash_len` (section 6.2) |

`USER_ALTER` treats `roles`, `enabled` and `credentials` as **optional-with-presence**: an absent field
leaves that part of the record alone, and an explicitly empty `roles` array replaces the grant set with
nothing. A password reset is an alter with `credentials` and neither `roles` nor `enabled`; there is no
separate reset opcode. `version` is always required and is the store's current version (section 6.4);
an alter whose `version` is stale is refused `CONFLICT`.

### 6.2 The credential the driver derives

The driver hashes the new password locally and sends the result. A credential is accepted only if it
was derived like this:

- **Argon2id**, version `0x13` (19), the only algorithm and version accepted. Argon2i and Argon2d are
  refused, and so is any string other than `argon2id` in `algo`.
- **Salt**: a fresh random salt of at least 16 bytes, encoded standard base64 with padding. It must be
  fresh: a salt another account already stores is refused (section 7). The server derives a login with
  the **decoded** bytes of `salt`. The server checks, at USER_CREATE and USER_ALTER, that `salt` decodes
  as standard base64 and that the decoded length equals `params.salt_len` (itself at least 16); a salt
  that fails either check is refused `INVALID_ARGUMENT` and nothing is created or changed.
- **Output length**: exactly 32 bytes, encoded standard base64 with padding. `params.hash_len` must be
  `32`; any other value is refused, and so is a `hash` that does not decode as base64.
- **Parameters** (`params`, a document):

| Field | Type | Accepted range | Default |
|---|---|---|---|
| `memory` | integer | 65,536 to twice the server's configured `auth.argon2_memory` (default 64 MiB, so 65,536–131,072) | 65,536 (KiB, i.e. 64 MiB) |
| `iterations` | integer | at least 3, and at most twice the server's configured `auth.argon2_iterations` (default 3, so 3–6) | 3 |
| `parallelism` | integer | 1 to 16 | 4 |
| `salt_len` | integer | at least 16 | 16 |
| `hash_len` | integer | exactly 32 | 32 |

The defaults are the server's own; the driver uses them unless the program says otherwise, and a value
outside a range is refused `INVALID_ARGUMENT` with a message naming the permitted range. A driver does
not have to match the server's configured work factor: it must only land inside the range above.
`memory` is in KiB. Lanes (`parallelism`) split the memory cost rather than multiply it.

A driver does not send the password, so **the server cannot measure it**: the driver applies the
password policy itself, before deriving. It refuses a password shorter than `AUTH_OK`'s
`password_min_length`, counted in Unicode characters, with an error naming the length, the minimum and
`HOARDDB_PASSWORD_MIN_LENGTH`, and never the password. It uses the number from the server it is
connected to, never a constant of its own; absent or zero means the server reported none, and the
driver refuses rather than guess. (This is the same rule section 5 states; it is repeated here because
this is where a new password is chosen.)

### 6.3 The answers

A **mutation success** (create, alter, drop, grant, revoke) answers with the request's own opcode and
`{success, message, version, changed?}`: `version` is the store's version after the change (present it
to the next alter), and `changed` is present **only on a `USER_ALTER` success**: it names the fields the
request carried and the server applied (`"roles"`, `"enabled"`, `"credentials"`, in that order). A driver that asked
an alter to change a field requires that field in `changed`, because a server that predates the field
answers success without applying it; an alter answer carrying no `changed` list is an older server, and
the driver says so instead of reporting success. A create, drop, grant or revoke answers without
`changed`; a driver does not require it there. A replayed `request_id` answers
`duplicate request ignored (already applied)` with success and no `changed`, so a driver checks
`changed` only on an alter answer whose message is not that one.

`USER_LIST` answers `{users, message?, version?, master?, master_addr?}`. `users` is an array ordered by
username, and each element is `{username, roles, enabled, epoch, created_at, password_changed_at}`:
`roles` is the grant array, `enabled` a bool, `epoch` an integer (the revocation counter),
and the two timestamps BSON datetimes. **No hash, salt or pepper is ever in an answer.** `master` and
`master_addr` name the node that serves mutations (section 7). `USER_LIST` sends an empty request
payload.

`USER_GET` answers `{found, user, version?, message?}`. A known user is `found: true` with the same
`user` shape as a `USER_LIST` element. An unknown user is a **success**, not an `ERROR`: `found: false`,
an empty `user`, the store's `version`, and a `message` such as `user "ada" not found; run 'user list' to
see the users`. A driver presents `found: false` as its not-found answer, as it does for a `GET` miss
(`errors.md` section 2).

### 6.4 The `version` an alter presents

`version` is the user store's config version, not a per-user counter: it moves on **every** accepted
user change anywhere in the store. `USER_LIST` and `USER_GET` both answer it, and both are served by any
node. An alter whose `version` is not the current one is refused `CONFLICT` (`0x08`); the driver re-reads
with `USER_GET` and retries. That is coarser than a per-user fence, and deliberately so: two drivers
editing two different users can refuse each other, and the retry is a re-read.

## 7. User-administration refusals

A driver that offers the user-administration opcodes (`USER_CREATE` B5, `USER_ALTER` B6, `USER_DROP`
B7, `USER_LIST` B8, `USER_GET` B9, `USER_GRANT` BA, `USER_REVOKE` BB) needs `user-manager` or `root`
authority, because the server authorizes all seven against the `user-manager` action (section 5). (The
server's own `-reset-password` flag is an offline command run with the server stopped, not a wire
request; a driver never sends it and never sees its output.)

**A user-administration refusal is an `ERROR` frame (`0xA2`), not an in-band `success: false`.** The
request's own opcode is used only for a success; a failure carries the shared `ERROR` payload of
`errors.md` section 1 (`code` and `message`) and never `write_outcome`, `copies_confirmed` or
`replication_factor`, because a user change is not a data write. The connection stays open. Before
AUTH succeeds the request is `NOT_AUTHENTICATED` (`0x0C`) like any other.

The `code` of a user-administration refusal names the cause, with the codes the database and bucket
verbs use (`errors.md` section 2), so a driver branches on the `code`, not on the `message`; the `message`
names the user or role and the fix, and a driver passes it through verbatim.

| Situation | Code | `message` shape |
|---|---|---|
| the caller lacks `user-manager`/`root` | `PERMISSION_DENIED` `0x03` | `permission denied: user "<u>" lacks "user-manager" on "*"`, then the user's roles and `ask an administrator to run: grant role user-manager@* to <u>` |
| the request arrives before AUTH | `NOT_AUTHENTICATED` `0x0C` | `connection not authenticated; send AUTH first` |
| `create user` of a name that exists | `ALREADY_EXISTS` `0x02` | names the user, and says to choose another name or `alter user` it |
| `alter`, `drop`, `grant` or `revoke` on a user that does not exist | `NOT_FOUND` `0x01` | names the user and says `run 'user list' to see the users` |
| `alter` with a `version` that is not the store's current one | `CONFLICT` `0x08` | names the user, the store's version and the request's, and says to re-read the user and retry |
| an unknown or retired role name; credential material the server rejects (algorithm, empty salt or hash, a hash or salt that is not base64, a decoded salt whose length is not `params.salt_len`, work factor outside the permitted range); a salt another account already uses; an empty or reserved username; a payload that does not decode as the request's BSON | `INVALID_ARGUMENT` `0x04` | names the user or role and the fix (the valid roles, the permitted range, "choose a fresh random salt", "choose another username") |
| a change that would leave no enabled `user-manager`, `cluster-manager` or `root`; a `create user` past the user ceiling | `INVALID_ARGUMENT` `0x04` | the reason is in the message: `refusing to remove the last administrator` with `grant that role to another enabled user first`, or `user limit reached` with `remove accounts before adding more` |
| a mutation on a node that is not the cluster's master; a mutation that cannot reach a quorum; a node whose member list no member has confirmed, whose founder has not answered, or that shares its node id with a second process | `UNAVAILABLE` `0x06` | names the master and its address, the quorum counts, the unconfirmed list, the silent founder (and how to join, start or remove it), or the duplicated node id and that `status` says which process holds it |

`INTERNAL` (`0x05`) is left for a real server fault, such as a users file the server cannot write.

**The last administrator cannot be removed.** The store always keeps at least one **enabled** account
holding `user-manager`, `cluster-manager` or `root`; `reader`, `writer`, `db-manager`,
`backup-operator` and `restore-operator` do not count. Three requests can strip that account, and all
three are refused `INVALID_ARGUMENT` with the message `refusing to remove the last administrator: it is
the only enabled user-manager/cluster-manager; grant that role to another enabled user first`:

- `USER_DROP` of it;
- `USER_ALTER` that sets `enabled: false` on it;
- `USER_ALTER` or `USER_REVOKE` whose new role set no longer holds one of those three roles for it.

The check is made against the state the request would leave, under the store's writer lock, so two
concurrent drops cannot each see the other's administrator still present and both succeed. A driver
reports this as a refusal the caller must fix by granting the role elsewhere first; it is never
retried, and the message is passed through verbatim.

**Retrying a user-administration `UNAVAILABLE`.** The refusal is raised before the store is touched, so
nothing was applied, although the frame carries no `write_outcome` (a user change is not a data write).
A driver may retry it with backoff, bounded by the caller's deadline, resending the same `request_id`:
the server remembers a successfully applied `request_id` for ten minutes and answers a repeat with
success, so a retry cannot apply the change twice. Two cases differ in *where* to retry. "Not the master"
is not cured by waiting on the same node: send the command to the master address the message names (or
find it with `USER_LIST`, which answers `master` and `master_addr`). A node that is not yet confirmed as
a member, or that shares its node id, clears only when an operator acts, so a driver retries within its
deadline and then surfaces the message. Every other code in the table is `never` in `errors.md` section 6.

The messages a driver will see:

| Refusal | `message` |
|---|---|
| duplicate name | `create user "ada": user already exists; choose another name, or change the existing account with 'alter user ada ...'` |
| past the user ceiling | `create user "ada": user limit reached: this store supports N users; remove accounts before adding more, for example 'drop user <name>' ('user list' shows them)` |
| salt already in use | `create user "ada": credential salt is already in use: choose a fresh random salt (reusing one salt across accounts makes a single leak a lookup table)` |
| salt not base64, or wrong length | `create user "ada": the credential is not acceptable: credential salt must be standard base64 of salt_len (16+) bytes; the client derives it — check the driver's credential encoding (the salt decodes to 4 bytes but params salt_len is 16); derive the credential again with the 'hoarddb' CLI or a current driver, which build it correctly` |
| credential out of range | `alter user "ada": the credential is not acceptable: credentials params iterations N is below the minimum of M; derive the credential again with the 'hoarddb' CLI or a current driver, which build it correctly` |
| reserved username | `create user "node": username is reserved: "node" names the cluster's node identity; choose another username` |
| empty username | `create user: a username is required; give the account a name: 'create user <name> roles [reader@<database>]'` |
| unknown user | `drop user "ada": user not found; run 'user list' to see the users` |
| stale version | `alter user "ada": user config version mismatch: this user store is at version N, the request carried M; re-read the user and retry` |
| last administrator | `drop user "admin": refusing to remove the last administrator: it is the only enabled user-manager/cluster-manager; grant that role to another enabled user first` |
| unknown or retired role | `grant role nope@app to "ada": unknown role "nope". The valid roles are reader, writer, …` |
| not the master | `user changes are served by the cluster master`, then `this node: … (not the master)`, `master: … at …`, and the address to run the command against |
| no quorum | `no quorum: user changes need a strict majority of the N current cluster members (need M), but only K could be reached; this is retryable …` |
| payload does not decode | `user create request: payload is not well-formed BSON (…); nothing was changed. Build the request with the 'hoarddb' CLI or a current driver, which send the documented fields` |

A create/alter/drop/grant/revoke **success** carries the same opcode and a payload with `success`,
`message`, `version` (present it to the next alter) and, on an alter only, `changed`, the list of
fields the server applied (section 6.3). A driver that asked an alter to change a field must require
it in `changed`, because a server that predates the field answers success without applying it. `USER_LIST` answers its
own list response. **`USER_GET` of an unknown user is a success, not an `ERROR`**: `found: false`, an
empty `user`, the store's `version`, and a `message` such as `user "ada" not found; run 'user list' to
see the users`. A known user is `found: true`. A driver presents `found: false` as its not-found
answer, as it does for a `GET` miss (`errors.md` section 2).

## 8. What a user change does to a live session

A user change reaches a live session at its next AUTH or token refresh, never in the middle of a
request, and the refusal a driver sees depends on which kind of change it was. This is the part a
driver's session handling depends on, so it is stated rather than left to the server's internals.

| The change | A token minted before it | Why |
|---|---|---|
| a **password** change (`USER_ALTER` with `credentials`) | `TOKEN_INVALID` (`3`) on the next AUTH or refresh | the server bumps the account's revocation counter, and a token whose counter is stale is invalid |
| the account **disabled** (`USER_ALTER` with `enabled: false`) | `TOKEN_INVALID` (`3`) on the next refresh; the server also **closes that user's live connections** | the counter is bumped, and a disabled account's sessions are closed |
| the account **dropped** | `TOKEN_INVALID` (`3`) on the next refresh; live connections are closed | the token's subject no longer exists |
| a **role set replaced** by `USER_ALTER` with `roles` and neither `credentials` nor `enabled: false` | still accepted, and the refreshed token carries only the roles both the record and the presented token hold: a removed role is gone, and an added one is not picked up | the counter is not bumped; a refresh narrows to the intersection of the record and the presented token, never widens |
| one grant **added or removed** by `USER_GRANT` / `USER_REVOKE` (that changed something: granting a grant the user holds, or revoking one it lacks, is a no-op that bumps nothing) | `TOKEN_INVALID` (`3`) on the next AUTH or refresh | each of these bumps the revocation counter; the live connection is not closed, and the password fallback of section 3 mints a token with the new roles |

**A revoked token is `TOKEN_INVALID`, never `CREDENTIALS`.** That distinction is what a session handler
is built on: `TOKEN_INVALID` is the fallback of section 3 (authenticate again with the password, once,
on a new connection), and `CREDENTIALS` means the password itself is wrong and is never retried. A driver
therefore must not treat `TOKEN_INVALID` as the end of the session: the password may still be right and
the user may simply have changed it elsewhere.

`TOKEN_EXPIRED` (`2`) is the other half of the same rule: it means a signature-valid token that is past
its own expiry or past `token_deadline`, which is the ordinary refresh boundary, not a revocation. A
driver tells them apart by the `reason` and handles both the same way (section 3 item 4).

Two consequences a driver states in its own documentation:

- a password change made by another process ends this client's session at its next refresh, and the
  client's next call authenticates with the password it holds — which is now the old one, so it fails
  `CREDENTIALS`. That is not a driver bug; the program must supply the new password.
- a role change takes effect at the next AUTH or refresh, not immediately: a call made in the seconds
  after a revoke may still be authorized with the old grants of the live connection. After `USER_GRANT`
  or `USER_REVOKE` the next refresh is refused `TOKEN_INVALID` and the password fallback of section 3
  authenticates with the new roles. After a role set replaced by `USER_ALTER` the refresh succeeds and
  only narrows: a role newly added appears only on a **new password login**, because a refresh keeps
  what the presented token already carried. A driver that needs new authority now authenticates with
  the password again.

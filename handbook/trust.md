# Trust and the connection URI

How a driver knows it is talking to the right server before it sends a password, and how a developer
writes down where that server is. Language-neutral; binds every driver.

## 1. What the server presents

Each hoardDB node mints a **self-signed ed25519 certificate** at first start and keeps it in its data
directory (`<data dir>/keys/server.key`, PKCS#8 PEM, and `server.crt`, PEM). There is no certificate
authority, no hostname in the certificate, and no operator-supplied certificate in this release: a
server configured for one refuses to start. So a driver cannot use its platform's CA verification. It
verifies the **key**.

At every start the server logs its key's fingerprint, for example (JSON log, one line):

    {"msg":"TCP driver listener listening","address":"127.0.0.1:7433","fingerprint":"SHA256:1e69…90ea", …}

That line is the documented out-of-band source for a pin.

## 2. The fingerprint

**`SHA256:` followed by the 64 lowercase hex characters of SHA-256 over the raw 32-byte ed25519 public
key.** Not over the certificate's DER, and not over the SubjectPublicKeyInfo structure that wraps the
key: over the 32 key bytes alone, which are the last 32 bytes of the key's SPKI DER encoding.

- Parsing a fingerprint a user typed: the prefix and the hex are accepted case-insensitively and
  canonicalised to `SHA256:` + lowercase. Anything else (a bare digest, another prefix, the wrong
  length) is refused with the expected shape named. There is exactly one format; do not accept
  "close enough" forms, because loose normalisation accepts unrelated keys.
- Comparing a presented key with a pin: in constant time, before AUTH.
- **Every driver must produce the identical string for the identical certificate.** The vectors carry
  certificates and keys with their fingerprints (group `trust`), and a conformance leg checks it.

## 3. The trust policy

A driver refuses to connect unless it can authenticate the server by one of these, tried in this order:

1. **A pinned fingerprint** (`?fingerprint=` in the URI, or an option). The production path, and the
   only one that needs no prior state. A mismatch is a hard failure naming **both** fingerprints, never
   a prompt and never a silent re-trust.
2. **The shared trust store, `~/.hoarddb/known_servers`.** The hoardDB command-line tool writes this
   file when a person trusts a server interactively, so a developer who has connected the CLI once has
   already trusted that server for every driver. A driver reads it by default and writes it only through
   option 4. A key that **changed** for a recorded host is a hard failure naming the old and new
   fingerprints, never re-prompted.
3. **A prompt the program supplies** (a callback `(host, fingerprint) -> accept?`). A library has no
   terminal, so **the default is no prompt**: an unknown server is refused with a message giving the
   ways forward (pin it, trust it once with the CLI, or, for local development, option 4).
4. **Accept on first sight**: a ready-made prompt that trusts and records the first key a host shows,
   as SSH does, and logs a warning. Local development only; never a default; never in a first example.
5. **Insecure mode**: verification off. Named, loud, off by default; it **requires a reason string**,
   which is logged at warning level on every connection attempt. It is not reachable by forgetting a
   parameter, and it is **not a URI parameter** (a URI is copied between environments; a flag is typed
   each time).

A driver that sets its TLS library's "skip verification" switch does so only to replace CA-chain
verification with its own key check, and never without that check installed. A unit test constructs
every combination of trust options and asserts the check is present in each.

## 4. The `known_servers` file

Default path `~/.hoarddb/known_servers`. The CLI, every driver, and the server for its own peers
(`<data dir>/cluster/known_servers`) read and write the file by the four rules below: the canonical host
form, the line grammar, file safety and saving. They are one contract for every driver.
`testdata/trust-vectors/v1.json` holds them as data, generated from the Go implementation
(`hoardDB/transport`; `testing.md` section 1.4), and a driver passes every vector in it.

### 4.1 The canonical host form

The first field of a line, and every lookup, is `host:port` in **one canonical form**, so two spellings
of one server can never be two entries. A driver canonicalises the address it dials before it looks it up
or records it, and canonicalises each line's host when it reads the file.

- A **registered name** is lowercased, and **one** trailing dot is stripped. It may hold ASCII letters,
  digits, `-`, `_` and `.`; an empty label (`db..internal`, `.db`) is refused.
- An **IPv4 address** is four decimal parts without leading zeros (`127.0.0.1`). A host made only of
  digits and dots that is not one (`127.000.000.001`, `1.2.3`) is refused, not read as a name.
- An **IPv6 address** must be written in brackets, and is recorded in the compressed form Go's
  `net/netip` prints (RFC 5952: lowercase hex, the longest run of zero groups as `::`, the leftmost run
  on a tie, a single zero group not compressed), in brackets. A zone (`%eth0`) is kept as written,
  and may hold only letters, digits, `-`, `_` and `.`. An IPv4-mapped address stays IPv6
  (`[::ffff:127.0.0.1]`).
- The **port is always written**: the default driver port, 7433, when the address has none. It is
  1 to 65535, at most five decimal digits, and leading zeros are dropped.
- `127.0.0.1` and `localhost` **stay different names**. No name is resolved, so a canonical form never
  depends on DNS.

| Written or dialled | Key in the file |
|---|---|
| `DB.Internal:7433`, `db.internal.:7433`, `db.internal` | `db.internal:7433` |
| `db:07433` | `db:7433` |
| `[::1]:7433`, `[0:0:0:0:0:0:0:1]:7433`, `[::0001]` | `[::1]:7433` |
| `[2001:DB8:0:0:1:0:0:1]:7433` | `[2001:db8::1:0:0:1]:7433` |
| `[FE80::1%eth0]:7433` | `[fe80::1%eth0]:7433` |
| `127.0.0.1:7433` | `127.0.0.1:7433` |
| `localhost:7433` | `localhost:7433` (not `127.0.0.1:7433`) |

Refused, with the reason named: `::1:7433` (an IPv6 address without brackets), `[127.0.0.1]:7433`
(brackets hold IPv6 only), port `0`, `65536`, `+7433` or `007433`, an empty port (`db:`, `[::1]:`), an
empty host, and a name with any other character. Check the characters on the name **as written, before
folding case**: Unicode lower-casing turns U+0130 into `i` and U+212A (the Kelvin sign) into `k`, so a
check made after it would accept a non-ASCII name as an ASCII one. Lowercase ASCII letters only.

Because the lookup is canonical, **a changed key under any spelling of a recorded host is a changed key**:
a server that once showed key A as `db.internal:7433` and now shows key B as `DB.internal.:7433` is
refused naming both fingerprints, never trusted as a first sight.

### 4.2 The line grammar

```text
# trusted with the hoardDB command-line tool        a comment: the first byte is '#'
db.internal:7433 <64 hex>                           an entry
db.internal:7434<TAB><64 hex><TAB>added by hand     an entry: tabs separate, text after the key is ignored
   [::1]:7433 <64 hex>                              an entry: leading spaces and tabs are ignored
                                                    a blank line
 # indented                                         malformed: " # indented" is not a comment, and "#" is not a host
db:7433<U+00A0><64 hex>                             malformed: U+00A0 is not a separator
```

- **Lines end at LF** (byte `0x0A`), and nothing else ends a line. **One** trailing CR (`0x0D`) is
  stripped, so a file saved with CRLF endings reads the same. A last line without LF is still a line.
- **Fields are separated by runs of ASCII space (`0x20`) and tab (`0x09`) only.** Form feed, vertical
  tab, a second CR, NEL (U+0085), no-break space (U+00A0), the line separator (U+2028) and every other
  character are part of a field, so a line that holds one where a separator should be is malformed.
- A line is `host:port`, a separator, the key, and optionally a separator and free text, which is
  ignored. The key is the **raw 32-byte ed25519 public key** in 64 hex characters (either case on read,
  lowercase on write), not its fingerprint.
- A line whose **first byte is `#`** is a comment. A line of nothing but spaces and tabs is blank. Both are
  ignored.
- A **malformed line** (one field, a host that does not canonicalise, a key that is not 64 hex
  characters) is skipped on read and **kept verbatim on write**: a save never drops or reorders a line it
  does not understand.
- **Two different keys for one canonical host is an error** when the file is loaded, naming the host and
  both fingerprints, never a choice between them. The same key twice is harmless.

### 4.3 File safety

On every read and before every write, on a POSIX system:

- The **file** must be a regular file, **not a symbolic link** (open it with `O_NOFOLLOW`, or `lstat`
  it, and refuse a link). A save through a link would write to the
  link's target, which may be a file the user never meant to be the trust store.
- The **directory** that holds it **may be a symbolic link** (container and Kubernetes mounts and dotfile
  managers link directories); the checks apply to the directory it resolves to.
- The file and that directory must be **owned by the current user or by root**, and must not be
  **group- or world-writable** (`mode & 022 == 0`). A file readable by others (`0644`) is accepted; a file
  `0620` or `0666`, or a directory `0770` or `0777`, is refused.
- A refusal names the path and gives the exact command that fixes it: `chmod 600 <file>`,
  `chmod 700 <directory>`, or `chown <uid> <path>`.
- A new file is created `0600` and a new directory `0700`, whatever the umask (set the mode after
  creating it).

**Known residual.** Only the file itself (opened without following a link, then checked on the open
file) and the directory holding it are checked. Directories above it, such as the home directory, are
neither checked nor held open between the check and the open, so a party that can write to one of them
could swap the trust directory between the two. That needs write access to the user's own home or a
parent of it, which already gives that party the user's account in practice; walking the path with
`openat` from the root would close it, and is not done in this release.

The Go implementation needs `flock` and POSIX ownership, so on a platform without them it refuses the
file store with a message that says to pin the server's fingerprint instead.

### 4.4 Saving

A save never truncates the file and rewrites it from what a process loaded earlier: two processes share
the file, and either may have added a line since.

- **The lock.** Every save holds an exclusive advisory `flock` on `<file>.lock`, a sibling file created
  `0600` and never deleted. A driver waits for it at most 5 seconds, then fails with an error naming the
  lock file. The wait is a blocking `flock` queued in the kernel, so waiters are served in arrival order
  instead of polling and racing for the release. One process keeps at most one such waiter per lock file, however many of its saves are waiting. Readers take no lock. What a reader can see while
  another process saves:
  - during an **append**, the line being appended may be read cut short, because one `write` is not
    atomic against a concurrent read. A reader may see the line being appended cut short; the line
    grammar makes it malformed, so it is skipped, and the reader sees every entry saved before that save
    and never a wrong key. A reader must therefore treat a last line without a complete 64-character
    key as malformed, which is already the rule of section 4.2: any prefix of `host:port key` either
    has no key or has a key that is too short;
  - during a **replace**, nothing partial: the new file is written aside and renamed into place, so a
    reader sees the old file or the new one.
- **Recording a first-seen server appends one line.** Under the lock, re-read the file (with the safety
  checks). If the host is now recorded with the same key, write nothing. If it is recorded with a
  different key, refuse: that is a changed key (section 3), naming both fingerprints. Otherwise append
  exactly `<canonical host:port> <lowercase hex key>` and LF, preceded by an LF if the file's last byte is
  not one, in one write, then `fsync`.
- **Replacing a key** (the explicit "accept the new key" action) writes a whole new file. Under the lock,
  re-read the file; write every line verbatim except the entries for that canonical host: the first one
  becomes `<canonical host:port> <lowercase hex key>`, later ones are removed, and if there was none the
  new line goes at the end; every line ends with LF. Write it to a temporary file in the same directory
  (created `0600`), `fsync` it, rename it over `known_servers`, then `fsync` the directory.
- **Leftovers.** A replace killed before its rename leaves a temporary file. Every save, holding the
  lock, removes the leftovers of its own naming pattern that are regular files owned by the user and
  older than a minute (Go: `.known_servers-*.tmp`); under the lock none can belong to a live save.

Before (a hand-edited file) and after recording `db2:7433` for the first time:

```text
# work servers                          # work servers
db1:7433 <key 1>  added by hand         db1:7433 <key 1>  added by hand
not a valid line                        not a valid line
                                        db2:7433 <key 2>
```

### 4.5 A changed key

The fix for a changed key, until the CLI gains a verb for it: delete that host's line from the file.
The refusal names both fingerprints, the line to delete and the file's path; the server's own message
for a peer does the same (it names `known_servers` and its path, never SSH's `known_hosts`).

The driver vectors carry `known_servers` lines a driver must accept and refuse (group `trust`); the
trust vectors (`testdata/trust-vectors/v1.json`) carry the four rules above.

## 5. Platform notes

- **Go:** a TLS config with the platform verification switched off and a peer-certificate callback that
  parses the leaf certificate, requires an ed25519 key, computes the fingerprint and applies the policy.
  Minimum version TLS 1.3; `NextProtos` exactly `["hoarddb/1"]`.
- **Node.js:** `tls.connect` with `ALPNProtocols: ['hoarddb/1']`, `minVersion: 'TLSv1.3'`,
  `rejectUnauthorized: false` **only together with** a check run on `secureConnect` before anything is
  written. The certificate's public key comes from the raw DER (`getPeerCertificate(true).raw`): parse
  it, take the SPKI, take the last 32 bytes. A SHA-256 of the whole certificate, or of the SPKI, is a
  different value and will never match the server's log line. Do this first: it is the one part of a
  Node driver that can cost a day.

## 6. The connection URI

The first line of every example anyone writes, so it is frozen. Grammar (RFC 3986 productions for
`pchar`, `reg-name`, `IPv4address`, `IPv6address`):

```abnf
uri        = "hoarddb://" [ userinfo "@" ] hostlist [ path ] [ "?" params ]
userinfo   = username [ ":" password ]
username   = 1*pchar                  ; "@" ":" "/" "?" "#" MUST be percent-encoded
password   = *pchar                   ; same rule; may be empty
hostlist   = hostport *( "," hostport )
hostport   = host [ ":" port ]
host       = reg-name / IPv4address / "[" IPv6address "]"
port       = 1*5DIGIT                 ; 1-65535
path       = "/" [ database [ "/" bucket ] ]
database   = 1*pchar
bucket     = 1*pchar
params     = param *( "&" param )
param      = name "=" value
```

- **One scheme, `hoarddb`**, matched case-insensitively. `hoarddb+tls://` does not exist (TLS is
  unconditional). `hoarddb+srv://` is refused **by name** ("DNS SRV lookups are not supported"). Any
  other scheme is refused with `scheme "<what was typed>" is not a hoardDB scheme; use hoarddb://`.
- **Default port 7433.** `:4433` parses (a parser does not know the deployment's ports), though it is a
  node's ring port, not a driver port.
- **Hosts** are tried in the order written; the first that completes TLS and AUTH wins. Later hosts are
  a fallback for an unreachable one, not load balancing, and a driver does not choose a host by bucket.
  An empty host (`hoarddb://a,/app`) is an error. An IPv6 literal must be bracketed. To look a host up
  in `known_servers`, or to record it, a driver uses its canonical form (section 4.1), with the default
  port written out: `hoarddb://DB.Internal./app` is checked as `db.internal:7433`.
- **Path**: `/database` sets a default database, `/database/bucket` also a default bucket. An empty path
  means no default.
- **Credentials** map onto AUTH's `username` and `password`. A bare `@` (or `:`, `/`, `?`, `#`) in a
  password is refused **by name** ("the password contains an unencoded '@'; percent-encode it as %40").
  An omitted password means "from elsewhere": the driver reads `HOARDDB_ROOT_PASSWORD` (and, for an
  omitted user, `HOARDDB_ROOT_USER`, default `admin`). Every rendering of a URI for a log or an error
  replaces the password with `***`.
- **Parameters**, names matched case-insensitively, all optional:

  | Name | Repeatable | Sets | Default |
  |---|---|---|---|
  | `fingerprint` | yes | the expected server key (section 3) | none |
  | `authToken` | no | AUTH's `token` (`auth.md`) | none |
  | `clientName` | no | AUTH's `client` | none |
  | `dialTimeoutMs` | no | dial + TLS handshake + AUTH deadline per host, milliseconds | 10000 |

  Fingerprints match hosts **positionally**; exactly one fingerprint applies to every host; any other
  count is an error naming both counts. The value `SHA256%3A…` (an encoded colon) is accepted.
- **Refused by name**, each with a sentence saying why it does not exist here: `tls`, `ssl`, `insecure`,
  `sslVerify`, `srv`, `replicaSet`, `readPreference`, `w`, `journal`, `authSource`, `authMechanism`,
  `retryWrites`, `directConnection`. Durability (`w`) and trust bypass (`insecure`) are options in code,
  never URI text.
- **Any other parameter is an error** naming the accepted set. A `#fragment` is refused.
- `HOARDDB_URI` is read when the program passes no URI.

The vectors in `testdata/uri-vectors/v1.json` are **hand-maintained** (a URI never crosses the wire, so
there is nothing to generate them from) and normative: `cases[]` must parse to exactly `expect` with the
`defaults` materialised; `invalid[]` must be refused with a message containing `error_contains`, and, when a case carries the optional
`error_excludes` (a list of substrings), with none of them in the message or in any wrapped cause: a refused
connection string never repeats the user info. `error_excludes` is additive; `format_version` stays 1. Tests
every driver carries besides the vector loop: the default port is 7433 asserted independently of the
file; a fingerprint is canonicalised; two fingerprints for three hosts is refused naming both counts;
an unknown parameter is refused naming the accepted set; a rendered URI never shows the password; the
SRV scheme is refused by name.

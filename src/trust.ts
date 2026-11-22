// SPDX-License-Identifier: Apache-2.0
//
// Which key belongs to which server, decided before the first password is written (handbook trust.md
// sections 2 to 4). The fingerprint is the SHA-256 of the raw 32 key bytes, never of the
// certificate: a certificate carries dates and a signature, so hashing one is a different value on
// every renewal, and the server logs this exact string at startup.
//
// The policy is four answers in a fixed order (handbook trust.md section 3): a pin, the shared
// known_servers file the command-line tool writes, the program's own callback, and insecure mode.
// Two of them are hard failures that never fall through to the next: a pin that does not match and
// a key that changed under a recorded host. Falling through would re-trust an intercepted server.

import { createHash, timingSafeEqual, X509Certificate } from 'node:crypto';
import { appendFile, mkdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import { ConfigError, ProtocolError, TlsTrustError } from './errors.js';
import { parseFingerprint } from './uri.js';

/** How a caller wants its server authenticated (build doc section 3.1). */
export interface TrustOptions {
  fingerprints?: string[];
  knownServersPath?: string | false;
  onUnknownServer?: (server: { host: string; port: number; fingerprint: string }) => boolean | Promise<boolean>;
  insecure?: { reason: string };
}

/** One trust answer: which of the four ways accepted the key, or the refusal. */
export type TrustDecision =
  | { ok: true; fingerprint: string; via: 'pin' | 'known' | 'prompt' | 'insecure' }
  | { ok: false; error: TlsTrustError };

/** The four ways to trust a server, already resolved: what decideTrust reads, nothing else. */
export interface TrustPolicy {
  pins: string[];
  known: KnownServers | null;
  onUnknownServer: ((server: { host: string; port: number; fingerprint: string }) => boolean | Promise<boolean>) | null;
  insecureReason: string | null;
}

/** The server's address as the trust store writes it: an IPv6 literal in brackets. */
function addressOf(host: string, port: number): string {
  return `${host.includes(':') ? `[${host}]` : host}:${port}`;
}

function keyFingerprint(keyHex: string): string {
  return fingerprintOfPublicKey(Buffer.from(keyHex, 'hex'));
}

function keyHexOf(rawKey: Uint8Array): string {
  return Buffer.from(rawKey).toString('hex');
}

/** The server's own log line at startup is "SHA256:" and the digest of the 32 raw key bytes. */
export function fingerprintOfPublicKey(raw32: Uint8Array): string {
  return `SHA256:${createHash('sha256').update(raw32).digest('hex')}`;
}

/**
 * The raw ed25519 key out of a certificate's DER. It is the last 32 bytes of the SubjectPublicKeyInfo,
 * which is a fixed 12-byte header around the key for this algorithm. A key of another type is
 * refused here rather than hashed: a different algorithm is a different trust decision.
 */
export function publicKeyOfCertificate(der: Uint8Array): Uint8Array {
  const key = new X509Certificate(der).publicKey;
  if (key.asymmetricKeyType !== 'ed25519') {
    throw new ProtocolError({
      message: `the server presented a ${key.asymmetricKeyType} key; a hoardDB server holds an ed25519 key, so this is not a hoardDB server`,
      operation: 'connect',
    });
  }
  const spki = key.export({ type: 'spki', format: 'der' });
  return new Uint8Array(spki.subarray(spki.length - 32));
}

/**
 * The shared trust store, read as the command-line tool writes it: one "host:port <64 hex>" per line,
 * the hex being the raw key and not its fingerprint. A malformed line is skipped, because a hand
 * edit should not lock a developer out; two different keys for one host is an error rather than a
 * choice, because picking either of them silently is how an intercepted server gets trusted.
 */
export function parseKnownServers(text: string, path: string): Map<string, string> {
  const entries = new Map<string, string>();

  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;

    const [address, key] = trimmed.split(/\s+/);
    if (address === undefined || key === undefined || !/^[0-9a-fA-F]{64}$/.test(key)) continue;

    const recorded = key.toLowerCase();
    const seen = entries.get(address);
    if (seen !== undefined && seen !== recorded) {
      throw new ConfigError('INVALID_OPTIONS', {
        message: `${path} records two different keys for ${address} (${keyFingerprint(seen)} and ${keyFingerprint(recorded)}); keep the line for the key the server presents now`,
        operation: 'knownServers',
      });
    }
    entries.set(address, recorded);
  }

  return entries;
}

/** Where the trust store lives unless a caller names another path or switches it off. */
export function defaultKnownServersPath(): string {
  return join(homedir(), '.hoarddb', 'known_servers');
}

/** One write at a time per path, so two connections meeting a new server append one line between them. */
const WRITES: Map<string, Promise<void>> = new Map();

function ignoreOutcome(): void {
  // The caller of the first write already saw the failure; the chain must not break for the next.
}

async function writeInOrder(path: string, work: () => Promise<void>): Promise<void> {
  const previous = WRITES.get(path) ?? Promise.resolve();
  const thisWrite: Promise<void> = previous.then(work, work);
  WRITES.set(path, thisWrite.then(ignoreOutcome, ignoreOutcome));
  await thisWrite;
}

async function statOrNull(target: string) {
  try {
    return await stat(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

/**
 * A file another user can write decides which servers this client trusts, so its mode is checked
 * before it is read or written and the refusal names the chmod to run. A file that does not exist
 * yet is not unsafe; the directory that will hold it is created 0700.
 */
async function refuseUnsafeModes(path: string): Promise<void> {
  const targets = [
    { target: dirname(path), what: 'directory', fix: '700' },
    { target: path, what: 'file', fix: '600' },
  ];

  for (const { target, what, fix } of targets) {
    const stats = await statOrNull(target);
    if (stats === null || (stats.mode & 0o022) === 0) continue;
    throw new ConfigError('INVALID_OPTIONS', {
      message: `the known-servers ${what} ${target} has mode ${(stats.mode & 0o7777).toString(8)}, so other users can change which servers you trust; fix it with: chmod ${fix} ${target}`,
      operation: 'knownServers',
    });
  }
}

async function readOrEmpty(path: string): Promise<string> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '';
    throw new Error(`could not read the known-servers file ${path}: ${(error as Error).message}`);
  }
}

function keyChangedMessage(address: string, path: string, presentedHex: string, recordedHex: string): string {
  return `The server at ${address} presented ${keyFingerprint(presentedHex)} but ${path} records ${keyFingerprint(recordedHex)} for it. Refusing to connect, and not retrying. If the server's key was rotated on purpose, delete the line for ${address} from ${path}; if not, the connection may be intercepted.`;
}

/**
 * The shared trust store: read on every connection, written only when the program's own callback
 * accepted a key. The file is shared between processes, so there is no lock to take: the write is a
 * single append and the conflict check runs on every load, which is enough because an append is
 * atomic below the page size and a whole line is what is added.
 */
export class KnownServers {
  readonly path: string;

  constructor(path: string) {
    this.path = resolve(path);
  }

  async lookup(address: string): Promise<string | undefined> {
    await refuseUnsafeModes(this.path);
    return parseKnownServers(await readOrEmpty(this.path), this.path).get(address);
  }

  async add(address: string, keyHex: string): Promise<void> {
    await writeInOrder(this.path, async () => {
      await refuseUnsafeModes(this.path);
      await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });

      const text = await readOrEmpty(this.path);
      const recorded = parseKnownServers(text, this.path).get(address);
      if (recorded === keyHex) return;
      if (recorded !== undefined) {
        throw new TlsTrustError('TLS_KEY_CHANGED', {
          message: keyChangedMessage(address, this.path, keyHex, recorded),
          operation: 'connect',
          target: address,
        });
      }

      const prefix = text === '' || text.endsWith('\n') ? '' : '\n';
      await appendFile(this.path, `${prefix}${address} ${keyHex}\n`, { mode: 0o600 });
    });
  }
}

/**
 * The four ways to trust, resolved once per client from the caller's options and the URI's pins.
 * A pin is canonicalised here so the comparison in decideTrust is between two equal-shaped strings.
 * A pin in the URI and a pin in the options are alternatives that share one positional list, so the
 * URI's come first and the count must still line up with the hosts.
 */
export function makeTrustPolicy(
  options: TrustOptions | undefined,
  uriPins: string[],
  hostCount: number,
): TrustPolicy {
  const pins = [...uriPins, ...(options?.fingerprints ?? [])].map(parseFingerprint);
  if (pins.length > 1 && pins.length !== hostCount) {
    throw new ConfigError('INVALID_OPTIONS', {
      message: `${pins.length} fingerprints were given for ${hostCount} hosts; give one fingerprint for all hosts, or exactly one per host in the order the hosts are written`,
      operation: 'connect',
    });
  }

  let insecureReason: string | null = null;
  if (options?.insecure !== undefined) {
    insecureReason = options.insecure.reason.trim();
    if (insecureReason === '') {
      throw new ConfigError('INVALID_OPTIONS', {
        message: 'tls.insecure was given no reason: pass tls: { insecure: { reason: "why verification is off" } }, because a trust bypass nobody wrote down is never reviewed',
        operation: 'connect',
      });
    }
  }

  const knownPath = options?.knownServersPath ?? defaultKnownServersPath();
  return {
    pins,
    known: knownPath === false ? null : new KnownServers(knownPath),
    onUnknownServer: options?.onUnknownServer ?? null,
    insecureReason,
  };
}

function sameFingerprint(pinned: string, presented: string): boolean {
  const left = Buffer.from(pinned, 'utf8');
  const right = Buffer.from(presented, 'utf8');
  return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * Authenticate the server that just answered the handshake, in the order handbook trust.md section 3
 * gives, and say in the refusal how to move forward. Nothing has been written when this returns, so
 * nothing has to be undone.
 */
export async function decideTrust(
  policy: TrustPolicy,
  server: { host: string; port: number; hostIndex: number; publicKey: Uint8Array },
): Promise<TrustDecision> {
  const address = addressOf(server.host, server.port);
  const fingerprint = fingerprintOfPublicKey(server.publicKey);
  const presentedHex = keyHexOf(server.publicKey);

  if (policy.insecureReason !== null) {
    process.emitWarning(`TLS verification is off for ${address}: ${policy.insecureReason}`, {
      code: 'HOARDDB_INSECURE_TLS',
    });
    return { ok: true, fingerprint, via: 'insecure' };
  }

  const pin = policy.pins.length === 1 ? policy.pins[0] : policy.pins[server.hostIndex];
  if (pin !== undefined) {
    if (sameFingerprint(pin, fingerprint)) return { ok: true, fingerprint, via: 'pin' };
    return {
      ok: false,
      error: new TlsTrustError('TLS_FINGERPRINT_MISMATCH', {
        message: `The server at ${address} presented ${fingerprint} but this client pinned ${pin}. Refusing to connect, and not retrying. If you rotated the server's key on purpose, update the pin; if not, the connection may be intercepted.`,
        operation: 'connect',
        target: address,
      }),
    };
  }

  if (policy.known !== null) {
    const recorded = await policy.known.lookup(address);
    if (recorded === presentedHex) return { ok: true, fingerprint, via: 'known' };
    if (recorded !== undefined) {
      return {
        ok: false,
        error: new TlsTrustError('TLS_KEY_CHANGED', {
          message: keyChangedMessage(address, policy.known.path, presentedHex, recorded),
          operation: 'connect',
          target: address,
        }),
      };
    }
  }

  if (policy.onUnknownServer !== null) {
    const accepted = await policy.onUnknownServer({
      host: server.host,
      port: server.port,
      fingerprint,
    });
    if (accepted) {
      if (policy.known !== null) await policy.known.add(address, presentedHex);
      return { ok: true, fingerprint, via: 'prompt' };
    }
  }

  return {
    ok: false,
    error: new TlsTrustError('TLS_UNTRUSTED', {
      message: `The server at ${address} presented key ${fingerprint}, which this client has not been told to trust. Nothing was sent: your password never left this process. Trust it one of three ways: pin it (hoarddb://${address}?fingerprint=${fingerprint}, the value the server prints at startup), trust it once with the hoardDB command-line tool (it records it in ~/.hoarddb/known_servers), or for local development pass tls: { onUnknownServer: acceptFirstSight }.`,
      operation: 'connect',
      target: address,
    }),
  };
}
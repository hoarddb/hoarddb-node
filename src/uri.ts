// SPDX-License-Identifier: Apache-2.0
//
// The connection URI (handbook trust.md section 6): the first line of every program a developer
// writes, so every refusal here names the thing that is wrong and the exact text to write instead.
// Nothing is guessed: the scheme, the port, the path and the parameter names are the grammar in the
// handbook, and the vectors in testdata/uri-vectors/v1.json are what it is pinned to.

import { isIPv6 } from 'node:net';

import { ConfigError } from './errors.js';

/** One entry of the host list, already stripped of its brackets and its port. */
export interface ParsedHost {
  host: string;
  port: number;
}

/** What a URI says, every default materialised, so a caller never has to know the defaults. */
export interface ParsedUri {
  hosts: ParsedHost[];
  username: string | null;
  password: string | null;
  database: string | null;
  bucket: string | null;
  params: {
    fingerprints: string[];
    authToken: string | null;
    clientName: string | null;
    dialTimeoutMs: number;
  };
}

/** The port a node's driver listener uses when the URI does not name one. */
export const DEFAULT_PORT = 7433;

/** The deadline for dialling one host, TLS handshake and AUTH together (D-25). */
export const DEFAULT_DIAL_TIMEOUT_MS = 10_000;

/** Every refusal of this module is the same refusal: the URI is wrong, and here is the fix. */
function refuse(message: string): never {
  throw new ConfigError('INVALID_URI', { message, operation: 'parseUri' });
}

/** The parameters that exist somewhere else on purpose, with the reason they do not exist here. */
const REFUSED_PARAMETERS: Readonly<Record<string, string>> = {
  tls: 'TLS 1.3 is always on and cannot be switched off',
  ssl: 'TLS 1.3 is always on and cannot be switched off',
  insecure:
    'trust bypass is never read from a URI, because a URI is copied between environments; use the --insecure flag of the command line tool, or tls: { insecure: { reason } } in this driver',
  sslverify:
    'trust is decided by a fingerprint, not by a certificate authority; use fingerprint=SHA256:<64 hex characters>',
  srv: 'DNS SRV lookups are not supported; list the hosts instead',
  replicaset:
    'hoardDB has no replica sets; list the nodes as host1,host2,host3 and the first reachable one is used',
  readpreference: 'hoardDB has no read preferences; a read is served by the node that answers',
  w: "write concern is not part of the URI; set it per client or per call in the driver's options",
  journal: 'hoardDB has no journal setting; write concern is set in the driver options',
  authsource: 'hoardDB has one user store; there is no authentication source to choose',
  authmechanism:
    'hoardDB has one authentication mechanism, a password or a token (authToken=...)',
  retrywrites:
    'the driver never retries a write on its own, because a retried push or increment applies twice',
  directconnection:
    'there is no topology discovery to switch off; the host list is tried in order',
};

/** The refusal for a user name or password that holds an '@', '/' or '?' written without percent-encoding. */
const UNENCODED_CREDENTIAL_ADVICE =
  "the user name or password contains an unencoded '@', '/' or '?'; percent-encode '@' as %40, '/' as %2F and '?' as %3F (and ':' as %3A) in the user name and password";

/** The spelling a refusal uses for an accepted parameter, which is not the lower-cased match key. */
const DISPLAY_NAMES: Readonly<Record<string, string>> = {
  fingerprint: 'fingerprint',
  authtoken: 'authToken',
  clientname: 'clientName',
  dialtimeoutms: 'dialTimeoutMs',
};

/**
 * The spelling a refusal may use for a parameter name: the driver's own spelling for a name in the
 * accepted or refused sets, and null for anything else, which is the user's text and is never
 * repeated.
 */
function displayName(lowerCaseName: string): string | null {
  if (Object.hasOwn(DISPLAY_NAMES, lowerCaseName)) return DISPLAY_NAMES[lowerCaseName] ?? null;
  if (Object.hasOwn(REFUSED_PARAMETERS, lowerCaseName)) return lowerCaseName;
  return null;
}

/**
 * The one fingerprint format the server prints: "SHA256:" and 64 hex characters, both accepted in
 * any case and canonicalised to lower. There is no "close enough" form, because loose
 * normalisation accepts unrelated keys.
 */
export function parseFingerprint(text: string): string {
  const trimmed = text.trim();
  if (trimmed.slice(0, 7).toLowerCase() !== 'sha256:') {
    refuse(
      'the fingerprint is missing the "SHA256:" prefix; the server prints it at startup as SHA256:<64 hex characters>',
    );
  }
  const hex = trimmed.slice(7);
  if (hex.length !== 64) {
    refuse(`the fingerprint has ${hex.length} hex characters after "SHA256:"; it must have exactly 64`);
  }
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    refuse('the fingerprint is not valid hex after "SHA256:"; it must be 64 characters of 0-9 and a-f');
  }
  return `SHA256:${hex.toLowerCase()}`;
}

/** Decode a name or value from the path or query; a bad escape is a refusal that does not quote it. */
function decodePart(text: string, what: string): string {
  try {
    return decodeURIComponent(text);
  } catch (error) {
    if (error instanceof URIError) {
      refuse(`the ${what} contains an invalid percent-escape; write a literal '%' as %25`);
    }
    throw error;
  }
}

/** A percent escape that does not decode is a typo a developer can see and fix, so it says so. */
function decodeField(text: string, what: 'user name' | 'password'): string {
  try {
    return decodeURIComponent(text);
  } catch (error) {
    if (error instanceof URIError) {
      refuse(`the ${what} contains an invalid percent-escape; write a literal '%' as %25`);
    }
    throw error;
  }
}

function parsePort(text: string): number {
  if (text === '') {
    refuse("a host has a ':' with no port after it; write host:7433 or just host");
  }
  if (!/^\d+$/.test(text)) {
    refuse('the port in the connection string is not a number; ports are 1-65535 and the default is 7433');
  }
  const port = Number(text);
  if (port < 1 || port > 65535) {
    refuse(`the port ${port} is out of range; ports are 1-65535 and the default is 7433`);
  }
  return port;
}

function hostName(name: string): string {
  if (/[ \t/\\@[\]]/.test(name)) {
    refuse("a host name contains a character that is not allowed in a host name (a space, '/', '\\', '@', '[' or ']')");
  }
  return name;
}

/** One entry of the host list: a bracketed IPv6 literal with its port, or a name with its port. */
function parseHostEntry(entry: string): ParsedHost {
  if (entry.startsWith('[')) {
    const close = entry.indexOf(']');
    if (close === -1) {
      refuse("the host list has an opening '[' with no closing ']'; an IPv6 literal is written [::1]:7433");
    }
    const literal = entry.slice(1, close);
    const afterBracket = entry.slice(close + 1);
    // No text after the bracket at all is the default port; anything there must be ':port'.
    if (afterBracket !== '' && !afterBracket.startsWith(':')) {
      refuse("a host has text after the closing ']' that is not a :port; write [::1]:7433");
    }
    if (!isIPv6(literal)) {
      refuse('a bracketed host is not an IPv6 address; brackets are only for IPv6 literals such as [::1]');
    }
    return {
      host: literal,
      port: afterBracket === '' ? DEFAULT_PORT : parsePort(afterBracket.slice(1)),
    };
  }

  if (entry.indexOf(':') !== entry.lastIndexOf(':')) {
    refuse(
      "a host has more than one ':' and looks like an IPv6 literal; an IPv6 literal must be bracketed with a port after the bracket, like [::1]:7433",
    );
  }
  const colon = entry.indexOf(':');
  if (colon === -1) return { host: hostName(entry), port: DEFAULT_PORT };

  const name = entry.slice(0, colon);
  if (name === '') {
    refuse('a host entry has no host name before the port; write host:7433');
  }
  return { host: hostName(name), port: parsePort(entry.slice(colon + 1)) };
}

/** A fingerprint given as a parameter says which parameter sent it, then why it is refused. */
function fingerprintParameter(value: string): string {
  try {
    return parseFingerprint(value);
  } catch (error) {
    if (error instanceof ConfigError) refuse(`parameter fingerprint: ${error.message}`);
    throw error;
  }
}

function parseQuery(query: string, params: ParsedUri['params']): void {
  const given = new Set<string>();
  for (const pair of query.split('&')) {
    const equals = pair.indexOf('=');
    const name = decodePart(equals === -1 ? pair : pair.slice(0, equals), 'parameter name').toLowerCase();

    const shown = displayName(name);

    const value = equals === -1 ? '' : decodePart(pair.slice(equals + 1), `parameter ${shown ?? 'value'}`);
    if (equals === -1 || value === '') {
      if (shown === null) {
        refuse(
          'a parameter has no value; write name=<value>, and the accepted parameters are fingerprint, authToken, clientName, dialTimeoutMs',
        );
      }
      refuse(`parameter "${shown}" has no value; write ${shown}=<value>`);
    }

    const why = Object.hasOwn(REFUSED_PARAMETERS, name) ? REFUSED_PARAMETERS[name] : undefined;
    if (why !== undefined) {
      refuse(`parameter "${shown}" is refused: ${why}`);
    }

    switch (name) {
      case 'fingerprint':
        params.fingerprints.push(fingerprintParameter(value));
        break;
      case 'authtoken':
      case 'clientname':
      case 'dialtimeoutms': {
        if (given.has(name)) {
          refuse(`parameter "${shown}" is given twice; only fingerprint may repeat`);
        }
        given.add(name);
        if (name === 'authtoken') {
          params.authToken = value;
        } else if (name === 'clientname') {
          params.clientName = value;
        } else {
          const timeout = Number(value);
          if (!/^\d+$/.test(value) || !Number.isSafeInteger(timeout) || timeout < 1) {
            refuse(
              'the dialTimeoutMs value must be a whole number of milliseconds greater than zero, for example dialTimeoutMs=3000',
            );
          }
          params.dialTimeoutMs = timeout;
        }
        break;
      }
      default:
        refuse(
          'an unknown parameter was given; the accepted parameters are fingerprint, authToken, clientName, dialTimeoutMs',
        );
    }
  }
}

/**
 * Parse a hoardDB connection URI. Every default is materialised, so the result of a parse is what
 * the client connects with, not something the client has to fill in. Any refusal is a ConfigError
 * with the code INVALID_URI whose message names the fix.
 */
export function parseUri(text: string): ParsedUri {
  if (text.includes('#')) {
    refuse(
      "fragments (a '#' and what follows it) are not part of a hoardDB connection string; remove it (a literal '#' inside a name must be written %23)",
    );
  }

  const schemeEnd = text.indexOf('://');
  if (schemeEnd === -1) {
    refuse('the text is not a connection string; it must start with hoarddb://, for example hoarddb://localhost:7433/app');
  }
  const scheme = text.slice(0, schemeEnd);
  const schemeFolded = scheme.toLowerCase();
  if (schemeFolded === 'hoarddb+srv') {
    refuse('DNS SRV lookups are not supported; list the hosts instead: hoarddb://host1:7433,host2:7433/');
  }
  if (schemeFolded === 'hoarddb+tls') {
    refuse(
      'the scheme hoarddb+tls is not a hoardDB scheme: TLS 1.3 is always on, so there is no separate TLS scheme; use hoarddb://',
    );
  }
  if (schemeFolded !== 'hoarddb') {
    refuse('the scheme is not a hoardDB scheme; use hoarddb://');
  }

  const afterScheme = text.slice(schemeEnd + '://'.length);
  // An '@' that is not the one ending the userinfo means the user name or password holds an
  // unencoded '@', '/' or '?'. The authority ends at the first '/' or '?', so left alone the text
  // after that character would parse as a host or a path, and the credentials would be sent to the
  // wrong host.
  const authorityEnd = afterScheme.search(/[/?]/);
  const beforeQueryText = afterScheme.split('?', 1)[0] ?? '';
  const countAt = (beforeQueryText.match(/@/g) ?? []).length;
  if (
    countAt > 1 ||
    (authorityEnd !== -1 &&
      !afterScheme.slice(0, authorityEnd).includes('@') &&
      afterScheme.slice(authorityEnd).includes('@'))
  ) {
    refuse(UNENCODED_CREDENTIAL_ADVICE);
  }
  const question = afterScheme.indexOf('?');
  const query = question === -1 ? '' : afterScheme.slice(question + 1);
  const beforeQuery = question === -1 ? afterScheme : afterScheme.slice(0, question);
  const slash = beforeQuery.indexOf('/');
  const authority = slash === -1 ? beforeQuery : beforeQuery.slice(0, slash);
  const path = slash === -1 ? '' : beforeQuery.slice(slash);

  let username: string | null = null;
  let password: string | null = null;
  let hostList = authority;
  const at = authority.lastIndexOf('@');
  if (at !== -1) {
    const userinfo = authority.slice(0, at);
    hostList = authority.slice(at + 1);
    if (userinfo.includes('@')) {
      refuse(UNENCODED_CREDENTIAL_ADVICE);
    }
    const colon = userinfo.indexOf(':');
    const rawName = colon === -1 ? userinfo : userinfo.slice(0, colon);
    const rawPassword = colon === -1 ? null : userinfo.slice(colon + 1);
    if (rawName === '') {
      refuse("the user name before '@' is empty; write hoarddb://user@host or leave the '@' out");
    }
    username = decodeField(rawName, 'user name');
    password = rawPassword === null ? null : decodeField(rawPassword, 'password');
  }

  if (hostList === '') {
    refuse('no host given; write hoarddb://host or hoarddb://host:7433');
  }
  const hosts = hostList.split(',').map((entry) => {
    if (entry === '') {
      refuse('the host list has an empty host (a stray comma?); write hoarddb://host1:7433,host2:7433');
    }
    return parseHostEntry(entry);
  });

  let database: string | null = null;
  let bucket: string | null = null;
  if (path !== '') {
    const segments = path.slice(1).split('/');
    if (segments.length > 2) {
      refuse(
        "the path has more than a database and a bucket; write /database or /database/bucket (a '/' inside a name must be written %2F)",
      );
    }
    const databaseSegment = segments[0] ?? '';
    // A bare trailing '/' is a path with no database (the vectors), but '//bucket' is not.
    if (databaseSegment === '' && segments.length > 1) {
      refuse('the path has an empty database name; write /database or /database/bucket');
    }
    if (databaseSegment !== '') database = decodePart(databaseSegment, 'database name');
    if (segments.length === 2) {
      const bucketSegment = segments[1] ?? '';
      if (bucketSegment === '') {
        refuse(
          "the path has an empty bucket name; write /database/bucket or drop the trailing '/'",
        );
      }
      bucket = decodePart(bucketSegment, 'bucket name');
    }
  }

  const params: ParsedUri['params'] = {
    fingerprints: [],
    authToken: null,
    clientName: null,
    dialTimeoutMs: DEFAULT_DIAL_TIMEOUT_MS,
  };
  if (query !== '') parseQuery(query, params);

  // One pin for every host, or exactly one per host in the order they are written: nothing between.
  if (params.fingerprints.length > 1 && params.fingerprints.length !== hosts.length) {
    refuse(
      `${params.fingerprints.length} fingerprints were given for ${hosts.length} hosts; give one fingerprint for all hosts, or exactly one per host in the order the hosts are written`,
    );
  }

  return { hosts, username, password, database, bucket, params };
}

function renderHost(host: ParsedHost): string {
  const name = host.host.includes(':') ? `[${host.host}]` : host.host;
  return `${name}:${host.port}`;
}

/**
 * The same URI with the password replaced by `***`, for a log line or an error message. The query
 * is left out entirely: it carries the auth token.
 */
export function redactUri(parsed: ParsedUri): string {
  const user =
    parsed.username === null
      ? ''
      : `${encodeURIComponent(parsed.username)}${parsed.password === null ? '' : ':***'}@`;
  const path = `${parsed.database === null ? '' : `/${encodeURIComponent(parsed.database)}`}${
    parsed.bucket === null ? '' : `/${encodeURIComponent(parsed.bucket)}`
  }`;
  return `hoarddb://${user}${parsed.hosts.map(renderHost).join(',')}${path}`;
}

// SPDX-License-Identifier: Apache-2.0
//
// The connection URI parser, pinned by testdata/uri-vectors/v1.json. The vectors hold both
// the accepted grammar and the refusals, but a parser is the first line of every program, so the
// refusals are checked for what they tell the developer to do: which sentence, which fix. Every
// refusal is a ConfigError with the code INVALID_URI (handbook trust.md section 6).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ConfigError } from '../../src/errors.js';
import {
  DEFAULT_PORT,
  parseFingerprint,
  parseUri,
  redactUri,
  type ParsedUri,
} from '../../src/uri.js';
import { loadUriVectors } from '../helpers/vectors.js';

const HEX_A = '3b7c1f0a9d2e4c6b8a0f5d3e7c1b9a4f6d2e8c0b5a7f9d1e3c5b7a9f0d2e4c68';
const HEX_B = '0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c4b5a69788796a5b4c3d2e1f0';

/** The parse shape of a vector's `expect`: its documentation fields beside it are not parsed. */
function expectedShape(vectorCase: { expect: unknown }): ParsedUri {
  const expected = vectorCase.expect as ParsedUri;
  return {
    hosts: expected.hosts,
    username: expected.username,
    password: expected.password,
    database: expected.database,
    bucket: expected.bucket,
    params: expected.params,
  };
}

test('every valid case parses to exactly expect', () => {
  const cases = loadUriVectors().cases;
  assert.ok(cases.length > 0, 'the vector file holds no valid cases');
  for (const vectorCase of cases) {
    assert.deepStrictEqual(parseUri(vectorCase.uri), expectedShape(vectorCase), vectorCase.name);
  }
});

// Joins the message of the error and of every wrapped cause, so an exclusion
// holds for the whole chain and not only the outermost message.
function errorChainText(error: Error): string {
  const texts: string[] = [];
  let link: unknown = error;
  while (link instanceof Error) {
    texts.push(link.message);
    link = link.cause;
  }
  return texts.join('\n');
}

test('every invalid case is refused with error_contains', () => {
  const invalid = loadUriVectors().invalid;
  assert.ok(invalid.length > 0, 'the vector file holds no invalid cases');
  for (const vectorCase of invalid) {
    assert.throws(
      () => parseUri(vectorCase.uri),
      (error: unknown) => {
        if (!(error instanceof ConfigError)) return false;
        assert.equal(error.code, 'INVALID_URI', `${vectorCase.name}: wrong code`);
        assert.ok(
          error.message.includes(vectorCase.error_contains),
          `${vectorCase.name}: "${error.message}" does not mention "${vectorCase.error_contains}"`,
        );
        const chainText = errorChainText(error);
        for (const excluded of vectorCase.error_excludes ?? []) {
          assert.ok(
            !chainText.includes(excluded),
            `${vectorCase.name}: the error chain repeats "${excluded}" from the refused string`,
          );
        }
        return true;
      },
      vectorCase.name,
    );
  }
});

test('the default port is 7433 independently of the file', () => {
  assert.equal(DEFAULT_PORT, 7433);
  const parsed = parseUri('hoarddb://node-a:7777,node-b/app');
  assert.deepStrictEqual(parsed.hosts, [
    { host: 'node-a', port: 7777 },
    { host: 'node-b', port: DEFAULT_PORT },
  ]);
});

test('a fingerprint is canonicalised', () => {
  assert.equal(parseFingerprint(`  sha256:${HEX_A.toUpperCase()}  `), `SHA256:${HEX_A}`);
  assert.equal(parseFingerprint(`SHA256:${HEX_A}`), `SHA256:${HEX_A}`);
  assert.throws(() => parseFingerprint(HEX_A), ConfigError);
  assert.throws(() => parseFingerprint(`SHA256:${HEX_A.slice(0, 40)}`), /exactly 64/);
});

test('two fingerprints for three hosts names both counts', () => {
  const uri = `hoarddb://n1,n2,n3/app?fingerprint=SHA256:${HEX_A}&fingerprint=SHA256:${HEX_B}`;
  assert.throws(
    () => parseUri(uri),
    (error: unknown) => {
      if (!(error instanceof ConfigError)) return false;
      assert.equal(error.code, 'INVALID_URI', 'wrong code for a fingerprint count mismatch');
      assert.ok(error.message.includes('2'), `"${error.message}" does not give the count of fingerprints`);
      assert.ok(error.message.includes('3'), `"${error.message}" does not give the count of hosts`);
      return true;
    },
  );
});

test('an unknown parameter names the accepted set', () => {
  assert.throws(
    () => parseUri('hoarddb://h/app?nonsense=1'),
    (error: unknown) => {
      if (!(error instanceof ConfigError)) return false;
      assert.ok(
        error.message.includes('the accepted parameters are fingerprint, authToken, clientName, dialTimeoutMs'),
        `"${error.message}" does not name the accepted parameters`,
      );
      return true;
    },
  );
});

test('redactUri never shows the password', () => {
  const parsed: ParsedUri = parseUri('hoarddb://u:pw-SECRET-1@h/db');
  const rendered = redactUri(parsed);
  assert.ok(!rendered.includes('pw-SECRET-1'), `"${rendered}" shows the password`);
  assert.ok(rendered.includes('***'), `"${rendered}" does not mark the password as redacted`);
  assert.ok(!rendered.includes('authToken'), `"${rendered}" renders a query`);
  assert.equal(redactUri(parseUri('hoarddb://[::1]:7433/app/Users')), 'hoarddb://[::1]:7433/app/Users');
});

test('the SRV scheme is refused by name', () => {
  assert.throws(
    () => parseUri('hoarddb+srv://cluster.example.com/app'),
    (error: unknown) => {
      if (!(error instanceof ConfigError)) return false;
      assert.ok(
        error.message.includes('DNS SRV lookups are not supported'),
        `"${error.message}" does not refuse SRV by name`,
      );
      return true;
    },
  );
});

/** The first run of three or more characters of `secret` that `text` repeats, or ''. */
function leakedFragment(text: string, secret: string): string {
  for (let start = 0; start + 3 <= secret.length; start += 1) {
    const fragment = secret.slice(start, start + 3);
    if (text.includes(fragment)) return fragment;
  }
  return '';
}

/** Every message and cause in an error's chain, and its string and JSON forms. */
function errorTexts(error: unknown): string[] {
  const texts: string[] = [];
  for (let current: unknown = error; current instanceof Error; current = current.cause) {
    texts.push(current.message, String(current), JSON.stringify(current), current.stack ?? '');
  }
  return texts;
}

// A password written without percent-encoding can contain '/', '?' or ':', which moves part of it
// into the host list, the path or the query. Whatever the parser refuses, the message names the
// problem and never repeats the connection string.
test('a refused URI never repeats the connection string or part of the password', () => {
  const passwords = [
    'Zq7xK9/Wm3pL',
    '4817/Xv2jQ/Rt5nB',
    '4817/Xv2jQ/Rt5nB/Hy6cD',
    '4817?Xv2jQ=Rt5nB',
    'Zq7xK9:Wm3pL?Hy6cD',
    'Zq7xK9?Wm3pL/Hy6cD',
    'Zq7xK9:Wm3pL:Hy6cD/Rt5nB',
    '4817?Xv2jQ&Rt5nB=Hy6cD',
    '[Zq7xK9]/Wm3pL',
    'Zq7xK9,Wm3pL/Hy6cD',
    'Zq7xK9%zzWm3pL',
    'Zq7xK9#Wm3pL',
  ];
  const templates = [
    'hoarddb://alice:%s@db.example:7433/app',
    'hoarddb://alice:%s@db.example:notaport/app',
    'hoarddb://alice:%s@db.example:99999/app',
    'hoarddb://alice:%s@db.example/app?bogus=1',
    'hoarddb://alice:%s@db.example/app/b/c',
    'hoarddb://alice:%s@db.example/app?dialTimeoutMs=abc',
    'hoarddb://alice:%s@db.example/app?fingerprint=nothex',
    'hoarddb://alice:%s@db.example/app?%zz=1',
    'hoarddb://alice:%s@db.example/%zz',
    'hoarddb://alice:%s@db .example/app',
    'hoarddb://alice:%s@[nope]/app',
    'hoarddb://alice:%s@db.example:/app',
    'hoarddb://alice:%s@a:b:c/app',
    'hoarddb+tls://alice:%s@db.example/app',
    'https://alice:%s@db.example/app',
    'alice:%s@db.example/app',
    '%s@db.example',
    'hoarddb://alice:%s@@db.example',
  ];
  for (const password of passwords) {
    for (const template of templates) {
      const text = template.replace('%s', () => password);
      let parsed: ParsedUri;
      try {
        parsed = parseUri(text);
      } catch (error) {
        assert.ok(error instanceof ConfigError, `parseUri(${JSON.stringify(text)}) threw a ${String(error)}, not a ConfigError`);
        for (const message of errorTexts(error)) {
          assert.equal(
            leakedFragment(message, password),
            '',
            `parseUri(${JSON.stringify(text)}): the error repeats part of the password: ${message}`,
          );
          assert.ok(!message.includes(text), `parseUri(${JSON.stringify(text)}): the error repeats the connection string`);
        }
        continue;
      }
      assert.equal(
        leakedFragment(redactUri(parsed), password),
        '',
        `parseUri(${JSON.stringify(text)}): redactUri repeats part of the password`,
      );
    }
  }
});

function refusal(text: string): ConfigError {
  try {
    parseUri(text);
  } catch (error) {
    assert.ok(error instanceof ConfigError, `parseUri(${JSON.stringify(text)}) threw ${String(error)}, not a ConfigError`);
    return error;
  }
  assert.fail(`parseUri(${JSON.stringify(text)}) succeeded`);
}

test('a bad percent-escape in the path or the query is a ConfigError, never a bare URIError', () => {
  for (const text of [
    'hoarddb://a:b@h/%zz',
    'hoarddb://a:b@h/app/%zz',
    'hoarddb://a:b@h/?%zz=1',
    'hoarddb://a:b@h/?clientName=%zz',
    'hoarddb://a:b@h/?%zz',
  ]) {
    assert.equal(refusal(text).code, 'INVALID_URI', text);
  }
});

// A token that is not part of the grammar (a parameter name, a value, a port, a host) is never
// repeated in a refusal, with or without a password in the string.
test('a refusal never repeats query, port or host text', () => {
  const token = 'Zq7xK9Wm3pL';
  const texts = [
    `hoarddb://db.example/app?${token}=1`,
    `hoarddb://db.example/app?${token}`,
    `hoarddb://db.example/app?${token}=`,
    `hoarddb://db.example/app?dialTimeoutMs=${token}`,
    `hoarddb://db.example/app?fingerprint=${token}`,
    `hoarddb://db.example/app?fingerprint=SHA256:${token}`,
    `hoarddb://db.example/app?fingerprint=SHA256:${token.repeat(6).slice(0, 64)}`,
    `hoarddb://db.example/app?authToken=a&authToken=${token}`,
    `hoarddb://db.example/app?${token}%zz=1`,
    `hoarddb://db.example/app?clientName=%zz${token}`,
    `hoarddb://db.example:${token}/app`,
    `hoarddb://db.example:${token}`,
    `hoarddb://${token} x/app`,
    `hoarddb://[${token}]/app`,
    `hoarddb://[::1]${token}/app`,
    `hoarddb://[${token}/app`,
    `hoarddb://${token}:1:2/app`,
    `hoarddb://:${token}/app`,
    `hoarddb://db.example/${token}/b/c`,
    `hoarddb://db.example/%zz${token}`,
    `${token}://db.example/app`,
    token,
  ];
  for (const text of texts) {
    for (const message of errorTexts(refusal(text))) {
      assert.equal(leakedFragment(message, token), '', `parseUri(${JSON.stringify(text)}) repeats the text: ${message}`);
    }
  }
});

test('a refusal may name a parameter from the fixed sets', () => {
  const cases: Array<[string, string]> = [
    ['hoarddb://h/app?dialTimeoutMs=soon', 'dialTimeoutMs'],
    ['hoarddb://h/app?authToken', 'authToken'],
    ['hoarddb://h/app?authToken=a&authtoken=b', 'authToken'],
    ['hoarddb://h/app?replicaSet=rs0', 'replicaset'],
    ['hoarddb://h/app?nonsense=1', 'fingerprint, authToken, clientName, dialTimeoutMs'],
  ];
  for (const [text, want] of cases) {
    assert.ok(refusal(text).message.includes(want), `${text}: ${refusal(text).message}`);
  }
});

test('the port range refusal reads the same in both drivers', () => {
  assert.equal(
    refusal('hoarddb://db.example:99999/app').message,
    'the port 99999 is out of range; ports are 1-65535 and the default is 7433',
  );
});

// A second '@' before the query means the user name or password holds an unencoded '@' (possibly
// with a '/'), and the text after it would otherwise parse as a host that receives the credentials.
test('more than one @ before the query is refused with the encoding advice', () => {
  for (const text of [
    'hoarddb://alice:ab@cd/ef@db.example:7433/app',
    'hoarddb://alice:ab@cd@db.example/app',
    'hoarddb://alice:ab@cd/ef@db.example',
    'hoarddb://alice@cd:ab@db.example/app',
  ]) {
    const { message } = refusal(text);
    assert.ok(message.includes('%40') && message.includes('%2F'), `${text}: ${message}`);
  }
  assert.doesNotThrow(() => parseUri('hoarddb://alice:pw@db.example/app?clientName=a@b'));
});

test('escape and leftover-@ refusals use the shared wording', () => {
  assert.equal(
    refusal('hoarddb://h/?Zq7xK9=%zz').message,
    "the parameter value contains an invalid percent-escape; write a literal '%' as %25",
  );
  assert.equal(
    refusal('hoarddb://h/?authToken=%zz').message,
    "the parameter authToken contains an invalid percent-escape; write a literal '%' as %25",
  );
  // No '@' before the first '/', one after it: the userinfo was cut in half.
  const { message } = refusal('hoarddb://alice:123/456@db.example/app');
  assert.ok(message.includes('%40') && message.includes('%2F'), message);
});

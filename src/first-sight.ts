// SPDX-License-Identifier: Apache-2.0
//
// Accept the first key a host shows and warn about it, the way SSH does (handbook trust.md section 3,
// option 4). It is a named callback the developer passes on purpose, never a default and never in a
// first example, because a key nobody compared is a key nobody checked.

/**
 * Trust the first key this host presents and record it in the known_servers file. Local development
 * only: every use prints a warning that says so.
 */
export function acceptFirstSight(server: {
  host: string;
  port: number;
  fingerprint: string;
}): boolean {
  process.emitWarning(
    `accepting the key of ${server.host}:${server.port} (${server.fingerprint}) on first sight; use this for local development only`,
    { code: 'HOARDDB_FIRST_SIGHT' },
  );
  return true;
}
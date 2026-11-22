#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Boeger IT Sh.p.k
#
# Licensed under the Apache License, Version 2.0; see LICENSE.

# The release gates that are about what the package is made of, not what it does:
#
#   licences  this repository is Apache-2.0, and every package in package-lock.json
#             is under a permitted licence (no copyleft, none unidentified)
#   deps      the runtime dependency is exactly bson, the development tools are
#             exactly the pinned three, and the lock file's runtime tree is bson alone
#   boundary  no source, test or script file imports from outside the package or from
#             any hoardDB server code (the package lint, run on the tree and then
#             proven able to fail by planting violations in a copy)
#   names     no other database product is named in a tracked file, outside a short
#             allow-list of files that must name one to work
#   private   no private reference (LAN address, developer home path, dev host name,
#             private git host, agent directory, a bug number not on the public list)
#             in a tracked file
#
#   scripts/compliance-check.sh [--only licences|deps|boundary|names|private] [directory]
#
# Exit 0 when every selected check passes, 1 when one fails (each failure is printed
# with the file or package at fault), 2 for a usage error. Needs node (22 or later);
# `npm ci` first, for the installed-licence part of the lint.
set -uo pipefail

only=""
if [ "${1:-}" = "--only" ]; then
  only="${2:-}"
  shift 2 || { echo "compliance-check.sh: --only needs licences, deps, boundary, names or private" >&2; exit 2; }
  case "$only" in licences|deps|boundary|names|private) ;; *) echo "compliance-check.sh: --only needs licences, deps, boundary, names or private" >&2; exit 2 ;; esac
fi
root="$(cd "${1:-$(dirname "${BASH_SOURCE[0]}")/..}" && pwd)" || exit 2
cd "$root" || exit 2

failed=0
fail() { echo "FAIL: $*" >&2; failed=1; }
selected() { [ -z "$only" ] || [ "$only" = "$1" ]; }

# The files that belong to the repository: tracked ones in a checkout, else everything
# outside the build and install directories.
tracked_files() {
  if git -C "$root" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    git -C "$root" ls-files
  else
    find . -type f -not -path './.git/*' -not -path './node_modules/*' -not -path './build/*' -not -path './dist/*' -not -path './.cache/*' | sed 's|^\./||'
  fi
}

# --- licences ---------------------------------------------------------------
check_licences() {
  if ! grep -q 'Apache License' LICENSE 2>/dev/null || ! grep -q 'Version 2.0, January 2004' LICENSE; then
    fail "licence: LICENSE is not the Apache License, Version 2.0"
  fi
  node - <<'JS' || failed=1
const { readFileSync } = require('node:fs');
const permitted = new Set(['MIT', 'BSD-2-Clause', 'BSD-3-Clause', 'Apache-2.0', 'ISC', 'Unlicense', 'CC0-1.0', 'MPL-2.0']);
const manifest = JSON.parse(readFileSync('package.json', 'utf8'));
const lock = JSON.parse(readFileSync('package-lock.json', 'utf8'));
let bad = 0;
if (manifest.license !== 'Apache-2.0') { console.error(`FAIL: licence: package.json says ${JSON.stringify(manifest.license)}, not "Apache-2.0"`); bad = 1; }
let count = 0;
for (const [path, entry] of Object.entries(lock.packages)) {
  if (path === '') continue;
  count += 1;
  if (!permitted.has(entry.license)) { console.error(`FAIL: licence: ${path} is under ${JSON.stringify(entry.license)}, which is not on the permitted list`); bad = 1; }
}
console.log(`licences: ${count} locked packages checked`);
process.exit(bad);
JS
}

# --- dependency graph -------------------------------------------------------
check_deps() {
  node - <<'JS' || failed=1
const { readFileSync } = require('node:fs');
const manifest = JSON.parse(readFileSync('package.json', 'utf8'));
const lock = JSON.parse(readFileSync('package-lock.json', 'utf8'));
const same = (actual, expected) => JSON.stringify(Object.keys(actual ?? {}).sort()) === JSON.stringify(Object.keys(expected).sort());
let bad = 0;
const fail = (text) => { console.error(`FAIL: dependency: ${text}`); bad = 1; };
if (!same(manifest.dependencies, { bson: 1 })) fail(`runtime dependencies are ${JSON.stringify(manifest.dependencies)}, not bson alone`);
if (!same(manifest.devDependencies, { '@types/node': 1, publint: 1, typescript: 1 })) fail('development dependencies are not exactly @types/node, publint and typescript');
const runtime = Object.entries(lock.packages).filter(([path, entry]) => path !== '' && !entry.dev && !entry.optional && !entry.peer).map(([path]) => path);
if (runtime.join() !== 'node_modules/bson') fail(`the lock file's runtime tree is ${runtime.join(', ') || 'empty'}, not node_modules/bson alone`);
console.log(`deps: runtime tree is ${runtime.join(', ')}; ${Object.keys(lock.packages).length - 1} locked packages in all`);
process.exit(bad);
JS
}

# --- import boundary --------------------------------------------------------
check_boundary() {
  node scripts/lint.mjs >/dev/null || { node scripts/lint.mjs >&2; fail "boundary: the package lint found violations"; return; }
  node scripts/lint-selftest.mjs >/dev/null 2>&1 || { fail "boundary: the lint self-test failed (the lint no longer catches planted violations)"; return; }
  echo "boundary: lint clean (imports stay inside the package, none from hoardDB server code), self-test passes"
}

# --- banned names -----------------------------------------------------------
# Words, matched whole and without regard to case. The list is another database's
# product names; the driver is built clean-room and says nothing about them.
banned='mongo|mongodb|mongosh|mysql|mariadb|postgres|postgresql|redis|cassandra|dynamodb|couchbase|couchdb|sqlite|memcached|rethinkdb|cockroachdb|elasticsearch|firestore|firebase|neo4j|scylla|scylladb|leveldb|rocksdb|oracle|sqlserver|influxdb|clickhouse|etcd'
# Files that must name one to work, and why:
#   testdata/uri-vectors/v1.json    a foreign URI scheme must be refused, frozen upstream
#   scripts/lint.mjs                the lint's banned-term list
#   scripts/compliance-check.sh     this list
#   package-lock.json               a package name or integrity string, never prose
allowed=(testdata/uri-vectors/v1.json scripts/lint.mjs scripts/compliance-check.sh package-lock.json)

check_names() {
  local file allow skip
  while IFS= read -r file; do
    [ -f "$file" ] || continue
    skip=0
    for allow in "${allowed[@]}"; do [ "$file" = "$allow" ] && skip=1; done
    [ "$skip" -eq 1 ] && continue
    if grep -qIiwE "$banned" "$file"; then
      fail "name: $file names another database product: $(grep -nIiwE "$banned" "$file" | head -3 | tr '\n' ' ')"
    fi
  done < <(tracked_files)
  echo "names: tracked files scanned"
}

# --- private references -----------------------------------------------------
# A private LAN address, a developer home path, the dev host name prefix, the private
# git host, an agent-tooling directory, and any bug number that is not on the short
# list of public ones. The patterns are built from fragments, so that this file does
# not itself spell what it forbids (a publish guard scans every tracked
# file, this one included, and a literal here would trip it). No withheld bug number
# is named anywhere: instead every BUG- number must be on the allow-list below.
# Add a number there only when its bug file is public.
lan='(^|[^0-9.])(10\.[0-9]{1,3}|172\.(1[6-9]|2[0-9]|3[01])|192\.168)\.[0-9]{1,3}\.[0-9]{1,3}'
host_prefix='da''lek-'
home_path='/ho''me/'
git_host='khme''re\.com'
agent_dir='\.cla''ude/'
private="$lan|$host_prefix|$home_path|$git_host|$agent_dir"
public_bugs='BUG-(0496|0514|0515|0516|0517|0629)'

check_private() {
  local file stray
  while IFS= read -r file; do
    [ -f "$file" ] || continue
    if grep -qIiE "$private" "$file"; then
      fail "private: $file holds a private reference: $(grep -nIiE "$private" "$file" | head -3 | tr '\n' ' ')"
    fi
    stray="$(grep -oIE 'BUG-[0-9]+' "$file" | grep -vxE "$public_bugs" | sort -u | tr '\n' ' ')"
    if [ -n "$stray" ]; then
      fail "private: $file cites a bug number that is not on the public list: $stray"
    fi
  done < <(tracked_files)
  echo "private: tracked files scanned"
}

selected licences && check_licences
selected deps && check_deps
selected boundary && check_boundary
selected names && check_names
selected private && check_private
exit "$failed"

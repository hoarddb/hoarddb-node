#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
#
# Optional helper: builds hoardDB-server from a checkout of the hoardDB repository and prints the
# binary's path, for running the server tests against a server newer than the pinned test release.
#
#   HOARDDB_REPO=/path/to/hoardDB-checkout HOARDDB_SERVER_BIN=$(scripts/build-server.sh) npm run test:server
#
# HOARDDB_REPO is the directory that holds the checkout's Go module (the one with cmd/server), or its
# parent. Needs Go. Normal use is scripts/fetch-server.sh, which needs no source.
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
repo="${HOARDDB_REPO:-}"
if [ -z "$repo" ]; then
  echo "build-server.sh: set HOARDDB_REPO to the path of a hoardDB checkout (or use scripts/fetch-server.sh)" >&2
  exit 1
fi
if [ -d "$repo/hoardDB/cmd/server" ]; then repo="$repo/hoardDB"; fi
[ -d "$repo/cmd/server" ] || { echo "build-server.sh: no cmd/server under $repo" >&2; exit 1; }
out="$root/.cache/hoardDB-server"
mkdir -p "$(dirname "$out")"
(cd "$repo" && go build -o "$out" ./cmd/server) >&2
echo "$out"

# Handbook

The handbook this driver was built from. Licensed under the Apache License, Version 2.0. Copyright 2026
Boeger IT Sh.p.k.

## Read this first: what this handbook describes

This handbook describes the protocol **this driver sends**: the opcodes of the hoardDB server's earlier
single-store engine, in which a bucket has one of six store types. It does not describe the ring protocol
of a hoardDB v1.1 server. That one is described in the handbook of the `hoarddb-go` repository
(`github.com/hoarddb/hoarddb-go`, directory `handbook/`).

A v1.1.0 server still answers the opcodes described here. Read these four points before the chapters:
where a chapter disagrees with one of them, the point is right for a v1.1.0 server.

1. **The data is separate.** The server answers these opcodes from the earlier engine's own store. Its
   databases and buckets are not the ring's: the `hoarddb` command line, `hoarddb dump` and a ring client
   do not see them, and this driver does not see theirs.
2. **There is no cluster for this protocol.** A v1.1.0 server refuses to start in the earlier engine's
   replicated mode. Every statement here about a cluster, an owner node, forwarding, replicas, copies of
   a bucket, a write concern met by several nodes, a node joining or leaving, and the three-node test
   recipe describes that mode. On a v1.1.0 cluster each node answers these opcodes from its own local
   store, and nothing is copied between nodes.
3. **The server and the command line are `hoarddb-server` and `hoarddb`.** A first start with no root
   password set asks for one on a terminal, or stops and says how to set `HOARDDB_ROOT_PASSWORD`; it does
   not print generated credentials.
4. **No test-server binary is published.** Build the server from `github.com/hoarddb/hoarddb-server`
   (`testing.md` section 3).

The chapters were written against the server commit recorded in `testdata/driver-vectors/v1.json`
(`server_commit`). Apart from the notes added for the points above, they have not been checked again,
statement by statement, against a v1.1.0 server.

## The chapters

| File | What it is |
|---|---|
| [`wire.md`](wire.md), [`trust.md`](trust.md), [`auth.md`](auth.md), [`errors.md`](errors.md), [`operations.md`](operations.md), [`testing.md`](testing.md) | the language-neutral chapters this driver is built from |
| [`api-go.md`](api-go.md) | the chapter of the Go module's root package `hoarddb`, which sends the same opcodes; kept here for reference. It does not describe the Go ring client |

The frozen test vectors in `../testdata/` win over every chapter. The Node driver has no chapter of its
own; its API is described in the repository's `README.md`.

A mistake in a chapter is reported as an issue in this repository.

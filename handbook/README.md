# Handbook

This folder is the hoardDB driver handbook. It is the same in every driver repository: a mistake in a
chapter is reported as an issue, and the fix is made in all of them.

| File | What it is |
|---|---|
| `wire.md`, `trust.md`, `auth.md`, `errors.md`, `operations.md`, `testing.md` | the language-neutral chapters every driver is built from |
| `api-go.md` | the Go driver's chapter; it binds the Go driver only and is kept here for reference |

The frozen test vectors in `../testdata/` win over every chapter. The Node driver's own chapter,
`api-node.md`, is not written yet.

Licensed under the Apache License, Version 2.0. Copyright 2026 Boeger IT Sh.p.k.

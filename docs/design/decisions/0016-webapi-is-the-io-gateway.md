# 16. The webapi is the sole I/O gateway and stability column

Date: 2026-06-18

## Status

Accepted. Amended 2026-08-09 — see [Amendment](#amendment-the-hook-is-a-second-writer).

## Context

The system has several backends (CouchDB, S3, Meilisearch) and several consumers
(webui, CLI, AI agents, third-party integrations). If each consumer talks to each
backend directly, every internal change — a renamed view, a new chunk format, a
swapped search engine — breaks every consumer, and there is no single place to
enforce shape, abstraction, or (later) auth.

We also want the internals to be *free to churn* (chunking on/off, S3 present or
not, Meilisearch swapped) **without** breaking the contract consumers rely on.

## Decision

The **webapi is non-optional and is the single gateway for all application I/O.**
It is the **stability column** — the most compatibility-reliable part of the
system, whose contract holds even as internals change, break, or toggle.

- **All writes** to CouchDB / S3 / Meilisearch go **through webapi endpoints**
  that abstract the internals. No consumer writes to a backend directly.
- **All reads** likewise go through the webapi — including reads of CouchDB docs
  and design-view output, and reads of S3 blobs.
- The webapi **transparently proxies, read-only**, to backends where their native
  API is itself a useful surface:
  - `/api/couch/*` → read-only passthrough to CouchDB's HTTP API (docs + design
    views are part of our API surface as-is).
  - `/api/s3/*` → read-only passthrough to S3 object reads.
  Writes are **never** proxied transparently — they always go through curated
  webapi endpoints that own the document/blob shapes.
- **webui and CLI are webapi clients**, nothing more. Their TypeScript API clients
  are **generated from the webapi's OpenAPI spec** (see
  [ADR 0019](0019-openapi-source-of-truth-generated-clients.md)).
- The one thing that legitimately bypasses the webapi is **host-side metadata
  ingestion** by the hook/CLI (reading local config/transcripts the container
  can't see) — that's an *input source*, still delivered *to* the webapi, not a
  backend write around it. *(Too narrow as written — see the
  [Amendment](#amendment-the-hook-is-a-second-writer): the hook writes to CouchDB
  and S3 directly.)*

## Consequences

- Internals can change freely behind a stable contract; a swapped search engine or
  a new chunk format is a webapi-internal change, not a consumer break.
- One place to add auth, rate limiting, masking, and validation later (Tier 3).
- The read-only proxies give power users and agents the full richness of CouchDB
  views / S3 without us re-implementing CRUD, while keeping writes funnelled.
- The webapi must be running for the system to be useful — accepted; it is the
  core. CouchDB behind it is the durable store.
- Adds a hop vs. direct backend access; acceptable for the abstraction and
  stability it buys.

## Amendment: the hook is a second writer

*2026-08-09.*

The exception above describes something narrower than what the code does, and the gap
is worth stating plainly rather than leaving a reader to infer that nothing writes
around the webapi.

**The hook writes to CouchDB and S3 directly.** Not metadata handed to the webapi —
its own connections, its own writes. All four of its actions:

| action | writes | how |
|---|---|---|
| `write-event-marker` | `event` docs | `ctx.couch.postDoc` |
| `flush-transcript-chunk` | `chunk` docs | `ctx.couch.putDoc` |
| `write-summary` | `summary` doc + `summary.json` | `ctx.couch.putDoc`, `ctx.blob.put` |
| `upload-blobs` | `transcript.jsonl` | `ctx.blob.put` |

### Why

**The hook must never block or fail a session**, and routing its writes through the
webapi would make recording a session depend on the webapi being up. Start Claude Code
before the stack, or during a container restart or an upgrade, and the session is lost
— silently, because a logging tool that surfaces its own failures is worse than one
that drops a record. Writing to the store directly means the writer depends only on the
store.

`backfill` is the contrast that shows this is a deliberate distinction rather than
drift: same CLI, same document builders, but it delivers through `/api/ingest/*` like
any other consumer. Backfill is interactive — a failure is visible and the command is
re-run. The hook is on the session hot path, where failure must be both invisible and
lossless. Different constraints, different path.

### What it costs, and what covers it

- **No write-time validation.** Doc schemas are validated at the webapi on write; the
  hook's writes skip that. Nothing validates a hook-written document today.
- **No write-time indexing.** The ingest routes index into Meilisearch as they write.
  Direct writes don't — which is exactly why the `_changes` follower exists
  ([ADR 0009](0009-meilisearch-search.md)): it catches whatever reaches CouchDB by any
  path, so a live-recorded session becomes searchable without coupling the writer to
  the reader.
- **Store credentials on the host.** The hook's runtime config carries CouchDB
  credentials (mode 0600), so they live outside the container as well as in it.

### What still holds

Everything else in the decision. The **read** path is unchanged — no consumer reads a
backend directly. The webui and CLI remain webapi clients with generated clients. The
gateway is still the stability column and still the one place to add auth, masking and
rate limiting later. The exception is one writer, on one path, for one reason.

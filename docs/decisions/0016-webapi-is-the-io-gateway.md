# 16. The webapi is the sole I/O gateway and stability column

Date: 2026-06-18

## Status

Accepted

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
  backend write around it.

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

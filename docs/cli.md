# CLI

> **Status: specified, not yet built.** This documents the intended design; the
> CLI does not exist as a package yet. Today its functions live as scripts under
> `hooks/scripts/` (`smoke-test`, `setup`) and the planned operational
> helpers under `scripts/` ([dev-automation.md](dev-automation.md)). The CLI
> consolidates them.

A terminal client for the system, and the **admin utility** for setup and data
operations. It is an **optional interface** — the system is fully usable without
it (and without the webui) — but it's the most convenient surface for humans at a
terminal and for **AI agents driving the system headless**.

## Two roles

1. **Application client** (talks to the webapi). Everything the webui can do, the
   CLI can do, because both are just webapi consumers
   ([ADR 0016](decisions/0016-webapi-is-the-io-gateway.md)): list/inspect sessions,
   read transcripts, query views via `/api/couch`, fetch blobs via `/api/s3`,
   run searches, post enrichment metadata. **All app-side reads and writes go
   through the webapi** — the CLI never touches CouchDB/S3 directly.
2. **Admin / host-side utility** (talks to the host). The operations that are
   inherently local: `smoke-test`, `install`/`setup` (register the hook, generate
   runtime config), `configure`, `export`/`import` (bundle round-trip), and
   `backfill` (adopt on-disk `~/.claude` transcripts as first-class history). Host-side
   **metadata ingestion** (reading local config/transcripts the container can't
   see) is the one legitimately non-webapi path — it's an input source, delivered
   *to* the webapi, not a backend write around it.

## Architecture — an aggregate of internal modules

The CLI is a **single tool assembled from multiple internal sources** — the same
way Claude Code itself is built. Each capability is its own TS module/package,
imported as an internal library; the CLI is the aggregate front end that exposes
them under one command surface:

| Internal module | Responsibility | Source |
|-----------------|----------------|--------|
| **webapi client** | All app-side reads/writes | **generated** from the webapi OpenAPI spec ([ADR 0019](decisions/0019-openapi-source-of-truth-generated-clients.md)) and imported as a lib — never hand-written |
| **`.claude/` reader/parser** | Read + parse the local `~/.claude/` filesystem (transcripts, projects, config) for `backfill` and verification | its own module/package within the CLI |
| **hooks setup** | Install/register the Claude Code hooks, generate runtime config | host-side |
| **export / import** | User-data bundle round-trip (dump/restore), format conversion | shares the [migrations](migrations.md) machinery |
| **admin** | `setup` / `configure` / `smoke-test` | host-side |

New functionality is added as **another internal module + a command**, so the tool
grows by composition. The `.claude/` reader is deliberately a standalone module
(like the generated client) so it can be reused/tested in isolation and never
blocks core CLI use if absent.

## Stack

- **Bun + [Ink](https://github.com/vadimdemedes/ink)** — the same runtime + TUI
  stack Claude Code itself is built with, so the CLI feels native alongside it and
  we can follow Claude Code's own Bun/TS/CLI build practices.
- **Generated API client** (above) — the same source of truth the webui uses.
- Reads the same backend config as the rest of the repo for host-side operations
  (`COUCHDB_*`, `S3_*`); for app-side operations it only needs the webapi base URL.

## Packaging (deferred)

To make the host-side CLI portable to machines without a Bun runtime, we intend to
ship **compiled single-file binaries** per OS (Bun supports `bun build
--compile`). The exact packaging/release flow is **deferred** — for now it runs
under Bun. In the combined container the CLI is **bundled in the image**, and the
webui offers a **download link** for it as a convenience
([containers.md](containers.md), [routes.md](routes.md)).

## Command surface (placeholder)

To be specified. Anticipated groups:

- `claude-transcripts sessions list|show|transcript …` — read the corpus (via webapi).
- `claude-transcripts search …` — query the search backend (via webapi).
- `claude-transcripts couch …` / `claude-transcripts s3 …` — power-user read access to the proxies.
- `claude-transcripts meta post …` — enrichment.
- `claude-transcripts setup|configure|smoke-test` — install/admin.
- `claude-transcripts backfill|export|import|migrate` — data lifecycle (`backfill` adopts
  on-disk transcripts; `export`/`import` is the bundle round-trip; see
  [migrations.md](migrations.md)).

# CLI

> **Status: built and released.** `@claude-transcripts/cli` ships as a compiled
> binary per platform on each release, and as the CLI bundled into the app image. It
> **is** the hook (`hook run`), the installer (`install`), and the admin surface
> (`backfill`, `export`/`import`, `migrate`, `reindex`, `doctor`, `sessions`,
> `search`). The scripts it consolidated are gone; `scripts/` now holds dev-only repo
> automation ([dev-automation.md](../develop/dev-automation.md)).

A terminal client for the system, and the **admin utility** for setup and data
operations. It is an **optional interface** — the system is fully usable without
it (and without the webui) — but it's the most convenient surface for humans at a
terminal and for **AI agents driving the system headless**.

## Two roles

1. **Application client** (talks to the webapi). Everything the webui can do, the
   CLI can do, because both are just webapi consumers
   ([ADR 0016](../design/decisions/0016-webapi-is-the-io-gateway.md)): list/inspect sessions,
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
| **webapi client** | All app-side reads/writes | **generated** from the webapi OpenAPI spec ([ADR 0019](../design/decisions/0019-openapi-source-of-truth-generated-clients.md)) and imported as a lib — never hand-written |
| **`.claude/` reader/parser** | Read + parse the local `~/.claude/` filesystem (transcripts, projects, config) for `backfill` and verification | its own module/package within the CLI |
| **hooks setup** | Install/register the Claude Code hooks, generate runtime config | host-side |
| **export / import** | User-data bundle round-trip (dump/restore), format conversion | shares the [migrations](../operate/migrations.md) machinery |
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
- **Finding the webapi** (`src/api/http.ts`) — `--webapi`, else `CT_WEBAPI_URL`, else
  `WEBAPI_PORT`, else the **installed instance's** `instance.env`, else `7650`.
  `install` allocates a port per instance, so without the `instance.env` step the bare
  commands would report a dead webapi on a port nothing was listening on. Only the
  *port* pins the target; `WEBAPI_HOST` just chooses the host for it — `.env.template`
  ships a `WEBAPI_HOST` and Bun loads it for anything run from a checkout, so letting
  it count as a named target would suppress the lookup. The webui's dev proxy resolves
  the same way ([webui.md](webui.md#build--dev-viteconfigts)). Resolution happens on
  **first use and is then memoised** — importing the module stays inert, so a fault in
  the resolver can't take down every command at load, and `--webapi` skips the instance
  read entirely.

## Packaging (deferred)

To make the host-side CLI portable to machines without a Bun runtime, we intend to
ship **compiled single-file binaries** per OS (Bun supports `bun build
--compile`). The exact packaging/release flow is **deferred** — for now it runs
under Bun. In the combined container the CLI is **bundled in the image**, and the
webui offers a **download link** for it as a convenience
([containers.md](../operate/containers.md), [routes.md](routes.md)).

## Command surface

The authoritative list is the app model's `cliSpec` — `claude-transcripts` with no
arguments renders help straight from it, so this table and the binary can't disagree
for long. As built:

**Lifecycle**

- `install` — set up everything: stores, app, search, and the Claude Code hook.
  Idempotent; re-run it to upgrade.
- `uninstall` — remove the instance (history survives unless `--purge`).
- `stack` — control the container stack directly.
- `provision` — create the CouchDB databases and the Garage bucket + key.

**Recording**

- `hook run|install|uninstall|status` — the hook itself, and its registration with
  Claude Code.
- `setup` — write the hook's runtime config and register it (the host-side path).

**Reading**

- `sessions [id]` — list sessions, or show one with a transcript preview.
- `search` — query the corpus.

**Data lifecycle**

- `backfill` — adopt on-disk `~/.claude` transcripts as first-class history;
  `--force` re-processes one already adopted.
- `export` / `import` — the portable bundle round-trip ([bundles.md](../design/bundles.md)).
- `migrate status|up|down` — schema migrations ([migrations.md](../operate/migrations.md)).
- `reindex` — rebuild the search indexes from CouchDB. They're derived state kept
  current by the ingest routes and the `_changes` follower, so this is the
  reconciliation step rather than the only path.

**Diagnosis**

- `doctor` — drive a synthetic session through write → read → search and remove it
  again. `--keep` leaves it for inspection.

Not built, and listed here only so the gap is visible: `couch` / `s3` power-user
passthroughs, and `meta post` enrichment.

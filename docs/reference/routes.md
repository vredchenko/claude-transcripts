# HTTP routes

> Every path below is served today. `/app`, `/docs` and `/cli/download` are mounted
> only when the webapi is pointed at the built SPA, docs and CLI binary
> (`CT_STATIC_DIR`, `CT_DOCS_DIR`, `CT_CLI_BIN` — the combined image sets all three).
> [webapi.md](webapi.md) has the per-route query parameters and response types.

A single combined container serves everything under one origin
([ADR 0002](../design/decisions/0002-single-combined-container.md)). The webapi is the
front door ([ADR 0016](../design/decisions/0016-webapi-is-the-io-gateway.md)).

| Path | Serves | Notes |
|------|--------|-------|
| `/` | **App manifest (machine-readable)** | JSON definition of the live app — the **agent/automation entrypoint**, not a human page. See below. |
| `/health` | **Liveness + store reachability** | Reports the app version and whether CouchDB is reachable and provisioned. What `install` polls, and the first thing to check when something looks wrong. |
| `/api` | **webapi** | The application JSON API (sessions, transcripts, turns, search, ingest, migrations). Stable contract. |
| `/api/sessions/{id}/turns` | **Speaker-split turns (per session)** | One side of the conversation (`?role=user`/`assistant`/…) or all turns, from `speaker_split/by_role` over full-content chunks ([ADR 0027](../design/decisions/0027-full-content-chunks-in-couchdb.md)). Empty for sessions logged without `couchFullContentChunks`. |
| `/api/turns` | **Cross-session turns** | Every turn of one speaker across **all** sessions, in time order (`?role=user`/`assistant`, optional `from`/`to` ISO bounds, `limit`/`skip`), from `speaker_split/by_role_time`. Each turn carries its `sessionId`/`cwd`. The corpus for cross-project pattern/repetition analysis. |
| `/api/search` | **Full-text search** | `?q=…` over Meilisearch. Returns `hits` (session **metadata** — cwd/model/tools/host, `sessions` index) **and** `turns` (conversation **content** — turn text with cropped snippets, `turns` index over `chunk.entries[]`). Best-effort — `enabled: false` + empty when Meili is disabled/unreachable. Gated by `features.meilisearch` ([ADR 0009](../design/decisions/0009-meilisearch-search.md)). |
| `/api/search/reindex` | **Rebuild the search indexes** | `POST` — clears both indexes and repopulates them from CouchDB (`summary` docs → `sessions`, full-content `chunk` entries → `turns`), reporting `scanned`/`indexed` per index plus any Meilisearch `failures`. The indexes are **derived** state. They are kept current two ways — the ingest routes index as they write, and a CouchDB `_changes` follower catches everything else, including the hook's direct writes — so a rebuild is the reconciliation step rather than the only path: history that predates search, anything the follower missed while down, and a corpus whose index names changed. Unlike the ingest hot path it **waits** for Meilisearch's asynchronous validation, so a rejected batch is reported rather than looking like a success. Driven by `cli reindex`. |
| `/api/docs` | **Scalar API reference** | Renders the published OpenAPI spec (the source of truth for generated clients) via Scalar. |
| `/api/ingest/*` | **Curated ingest (writes)** | The only write surface for consumers (the hook bypasses it — [ADR 0016 amendment](../design/decisions/0016-webapi-is-the-io-gateway.md#amendment-the-hook-is-a-second-writer)). `POST /api/ingest/summary` (validated, idempotent upsert), `POST /api/ingest/events` + `POST /api/ingest/chunks` (bulk append), `PUT /api/ingest/{id}/transcript` (blob → S3), `DELETE /api/ingest/{id}` (drop a session's derived docs so it can be re-ingested; `?blobs=true` also removes the transcript). Host-side `backfill` delivers here. |
| `/api/migrate/*` | **Schema migrations** | Status / up / down for the migration engine ([migrations.md](../operate/migrations.md)). Driven by `cli migrate`. |
| `/api/model*` | **App model introspection (read-only)** | Read-only app-model introspection (full counterpart to `/`). |
| `/api/couch/*` | **CouchDB proxy (read-only)** | Transparent passthrough to CouchDB's HTTP API — docs + design views as a first-class read surface. Writes are **not** proxied. |
| `/api/s3/{bucketKey}/*` | **S3 proxy (read-only)** | Read-only object reads by logical bucket key, e.g. `/api/s3/sessions/<id>/transcript.jsonl`. Writes go through curated webapi endpoints. |
| `/app` | **webui SPA** | The React app. Optional — can be disabled without affecting the API. |
| `/docs` | **Rendered technical docs** | The `docs/` tree built into the image by `bun run build:docs` ([containers.md](../operate/containers.md)); also published as the project site. |
| `/cli/download` | **CLI binary** | The image bundles the CLI; the webui links here for convenience. |

## `/` — the app manifest (agent entrypoint)

`/` is **reserved as a machine-readable manifest**, not a UI landing page (the UI
is `/app`) — [ADR 0022](../design/decisions/0022-root-route-is-a-machine-readable-manifest.md).
It serves a JSON (optionally MDX for prose) definition of *everything else about
the live app*, so another AI agent or tool can bootstrap from one request:

- **Routes/endpoints** available (a compact pointer to the full OpenAPI at
  `/api/docs`, plus the `/api/couch` + `/api/s3` proxies).
- **Non-secret config** the app is running with (a config-serving route).
- **Dynamic links** the webui consumes (e.g. the Services-menu URLs, so they're not
  hard-coded in the SPA — [#14](../design/roadmap.md)).
- **Version & build** info.
- Whatever else an agent needs to use the system.

`/api/docs` stays the human + OpenAPI surface; `/` is the compact machine front
door. Exact manifest schema TBD.

## Backing-service admin UIs

Not served by the app — these are the **bundled admin dashboards** for the backing
services, reached directly (and surfaced as links in the webui Services menu, see
[configuration.md](../start/configuration.md) → `servicesMenu`):

- **CouchDB Fauxton**, **Garage WebUI**, **Meilisearch** dashboard. In the bundled
  Docker Compose stack they run alongside the app; when backends are external the
  links point wherever those services live.

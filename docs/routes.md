# HTTP routes

> **Status: target layout.** Some routes exist today (`/api/...`, `/api/doc`,
> SPA static), others are planned (`/api/couch`, `/api/s3`, `/app` mount point,
> the `/` index, static docs). This is the intended shape; see
> [webapi.md](webapi.md) for what's implemented now.

A single combined container serves everything under one origin
([ADR 0002](decisions/0002-single-combined-container.md)). The webapi is the
front door and the only writer to the backends
([ADR 0016](decisions/0016-webapi-is-the-io-gateway.md)).

| Path | Serves | Notes |
|------|--------|-------|
| `/` | **App manifest (machine-readable)** | JSON/MDX definition of the live app — the **agent/automation entrypoint**, not a human page. See below. |
| `/api` | **webapi** | The application JSON API (sessions, transcripts, search, enrichment). Stable contract. |
| `/api/docs` | **Scalar API reference** | Renders the published OpenAPI spec (the source of truth for generated clients) via Scalar, replacing Swagger UI. (Implemented today as Swagger at `/api/doc`; target is Scalar at `/api/docs`.) |
| `/api/ingest/*` | **Curated ingest (writes)** | The *only* write surface (ADR 0016). `POST /api/ingest/summary` (validated, idempotent upsert), `POST /api/ingest/events` + `POST /api/ingest/chunks` (bulk append), `PUT /api/ingest/{id}/transcript` (blob → S3). Host-side `backfill` delivers here. |
| `/api/couch/*` | **CouchDB proxy (read-only)** | Transparent passthrough to CouchDB's HTTP API — docs + design views as a first-class read surface. Writes are **not** proxied. |
| `/api/s3/*` | **S3 proxy (read-only)** | Transparent passthrough to object reads (transcripts, summaries, blobs). Writes go through curated webapi endpoints. |
| `/app` | **webui SPA** | The React app. Optional — can be disabled without affecting the API. |
| _(in `/app`)_ | **CLI download link** | The image bundles the CLI binary; the webui links to it for convenience. |

## `/` — the app manifest (agent entrypoint)

`/` is **reserved as a machine-readable manifest**, not a UI landing page (the UI
is `/app`) — [ADR 0022](decisions/0022-root-route-is-a-machine-readable-manifest.md).
It serves a JSON (optionally MDX for prose) definition of *everything else about
the live app*, so another AI agent or tool can bootstrap from one request:

- **Routes/endpoints** available (a compact pointer to the full OpenAPI at
  `/api/docs`, plus the `/api/couch` + `/api/s3` proxies).
- **Non-secret config** the app is running with (a config-serving route).
- **Dynamic links** the webui consumes (e.g. the Services-menu URLs, so they're not
  hard-coded in the SPA — [#14](roadmap.md)).
- **Version & build** info.
- Whatever else an agent needs to use the system.

`/api/docs` stays the human + OpenAPI surface; `/` is the compact machine front
door. Exact manifest schema TBD.

## Backing-service admin UIs

Not served by the app — these are the **bundled admin dashboards** for the backing
services, reached directly (and surfaced as links in the webui Services menu, see
[configuration.md](configuration.md) → `servicesMenu`):

- **CouchDB Fauxton**, **Garage WebUI**, **Meilisearch** dashboard. In the bundled
  Docker Compose stack they run alongside the app; when backends are external the
  links point wherever those services live.

## Static docs (Tier 3)

For the public release, `docs/` is **built to static HTML** and served from the
same container alongside Swagger + webui + webapi (mount point TBD, e.g.
`/docs`) — see [tiers.md](tiers.md) → Tier 3 and [containers.md](containers.md).

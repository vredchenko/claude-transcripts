# @claude-transcripts/webapi

The gateway: Bun + [Hono](https://hono.dev) with
[`@hono/zod-openapi`](https://github.com/honojs/middleware/tree/main/packages/zod-openapi),
[`nano`](https://github.com/apache/couchdb-nano) for CouchDB, `Bun.S3Client` for S3, and
[Scalar](https://github.com/scalar/scalar) at `/api/docs`.

How it behaves and how to configure it:
[docs/reference/webapi.md](../../docs/reference/webapi.md). This page is about the
code.

```bash
bun run dev:webapi        # http://127.0.0.1:7650, restarts on change
bun run gen:clients       # after a contract change: rewrite openapi.json + the generated clients
bun run check:contract    # diff the spec against origin/main for breaking changes
```

## Code

| Path (`src/`) | Holds |
|---------------|-------|
| `index.ts` | Entry point: loads config, opens the CouchDB and S3 handles, ensures the schema, serves the app. |
| `server.ts` | Builds the Hono app: the routes, `/health`, and the static mounts (`/app`, `/docs`, `/cli/download`, `/downloads/`). |
| `config.ts`, `context.ts` | Runtime config (`config/` plus the environment), and the boot outcome `/health` reports. |
| `routes/` | `sessions`, `search`, `ingest`, `migrate` (typed, in the spec); `proxy` (CouchDB, S3, Fossil), `blueprint`, `manifest` (plain); `validation` shapes request-validation failures like every other error. |
| `storage/couch.ts` | `db(key)` opens a database by its logical key in `couchdb.databases`. |
| `storage/s3-blob-store.ts`, `storage/blob-store.ts` | Blob access; path-style addressing. Writes only via `PUT /api/ingest/{id}/transcript` and `DELETE /api/ingest/{id}?blobs=true`. Never creates the bucket. |
| `storage/ensure.ts` | Boot, idempotent: system databases, every configured database, pending migrations, the Mango index on `type`, then the session index and the change follower. |
| `storage/migrations.ts` | The migration engine's CouchDB writes (the CLI drives migrations through the webapi). |
| `storage/changes-follower.ts` | Follows `_changes` and keeps the session index and the search indexes current from it; starts the reconcile sweep. |
| `storage/search-buffer.ts`, `storage/turn-tiers.ts`, `storage/meili.ts` | Batching the feed's search work; the live and archive turn indexes and how turns move between them; the fetch-based Meilisearch client. |
| `storage/session-index.ts`, `storage/active-duration.ts` | The in-memory session list, and active time per session. |
| `storage/reconcile-sweep.ts` | Finalising sessions that never fired `SessionEnd`. |
| `caching.ts` | Compression and cache headers. |
| `openapi.ts`, `write-openapi.ts`, `contract-diff.ts` | Building the OpenAPI document offline, writing it to `openapi.json`, and deciding which differences between two versions break a consumer. |

## The contract

The typed routes are defined with `createRoute` + zod, so the OpenAPI spec is generated
from the code and committed as `openapi.json`. The webui and the CLI consume clients
generated from it; after changing a route, run `bun run gen:clients` and never
hand-write request code
([ADR 0019](../../docs/design/decisions/0019-openapi-source-of-truth-generated-clients.md)).

## Session index

`session_index/aggregate` has a JavaScript reduce, which CouchDB can't serve from
stored btree values when grouped per session, so querying it per request cost about
20 ms per session (8 s for ~460 sessions, [#107](https://github.com/vredchenko/claude-transcripts/issues/107)).
`src/storage/session-index.ts` runs the grouped query once at boot, then re-reads only
the sessions each `_changes` batch touches; the route filters, sorts and pages in
memory (5–70 ms).

- It is a cache: rows are stored as the view returns them, and `reindex` still queries
  CouchDB.
- It fails soft: while cold or after a failed load the route queries the view directly;
  a failed reload keeps the last good data.
- A full reload runs every 15 minutes in case the feed died, and `/health` reports its
  state.

The change follower therefore runs even with Meilisearch off.

## Search document ids

Meilisearch accepts only `a-zA-Z0-9`, `-` and `_` in document ids, so build them with
`searchDocId()`.

## Serving the SPA and docs

With `CT_STATIC_DIR` set, the SPA is served under `/app/` with an `index.html` fallback
for client-side routes (Vite builds with `base: "/app/"`). In development the variable
is unset and Vite serves the UI, proxying `/api` here.

`src/caching.ts`:

- **Compression** wraps Hono's `compress()` for every response. The wrapper measures the
  body itself, because a handler-built `Response` has no `Content-Length` and the stock
  threshold never fires. Binary bodies, `text/event-stream` and proxied continuous
  CouchDB feeds are not compressed. It must be registered before the routes.
- **Caching**: `/app/assets/*` (content-hashed) gets
  `public, max-age=31536000, immutable`; the SPA shell and `/docs/*` get `no-cache`
  with an ETag.

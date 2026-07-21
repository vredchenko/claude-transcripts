# webapi — codebase reference

A [Hono](https://hono.dev) + Bun service that reads sessions back out of CouchDB +
S3, exposes them over a small JSON API, and (in production) serves the built
`webui` SPA from the same process. **As built today it is read-only** for session
data (the only writes it does are idempotent schema setup on boot).

> **Direction** ([ADR 0016](decisions/0016-webapi-is-the-io-gateway.md)): the
> webapi is the project's **single I/O gateway and stability column** — the hook
> and all consumers will read *and write* through it, and it will add read-only
> `/api/couch` + `/api/s3` proxies. This doc describes the current code; see
> [architecture.md](architecture.md) and [routes.md](routes.md) for the target.

- **Package:** `packages/webapi/` (workspace name `@claude-transcripts/webapi`)
- **Runtime:** Bun, TypeScript (ESM, strict)
- **Framework:** Hono via [`@hono/zod-openapi`](https://github.com/honojs/middleware/tree/main/packages/zod-openapi) (OpenAPI-typed routes) + `@hono/swagger-ui`
- **CouchDB client:** [`nano`](https://github.com/apache/couchdb-nano)
- **S3 client:** Bun's built-in `Bun.S3Client` (no SDK dependency)

> **API docs tooling (decided).** **Keep the OpenAPI spec** — it's the contract
> source of truth and `orval` needs it to generate the CLI + webui clients
> ([ADR 0019](decisions/0019-openapi-source-of-truth-generated-clients.md)). The
> *rendered* docs at `/api/docs` will be served by
> **[Scalar](https://github.com/scalar/scalar)** (`@scalar/hono-api-reference`) —
> a modern reference UI over the same spec — replacing `@hono/swagger-ui`;
> `@hono/zod-openapi` stays for spec generation.

## File layout

| File | Purpose |
|------|---------|
| `src/index.ts` | Boot sequence: build config, open CouchDB + S3 handles, `ensureCouchDbs`, start the server. |
| `src/server.ts` | `OpenAPIHono` app factory: health check, OpenAPI doc + Swagger UI, optional SPA static serving. |
| `src/config.ts` | Config loader: `claude-transcripts.config.json` defaults overlaid with `.env`. |
| `src/routes/sessions.ts` | The session/transcript endpoints + their zod schemas; running-session detection. |
| `src/storage/couch.ts` | `makeCouchHandles(config)` — `nano` server + database handles. |
| `src/storage/blob-store.ts` | `BlobStore` interface (`get`, `stat`). |
| `src/storage/s3-blob-store.ts` | `S3BlobStore` — `Bun.S3Client` implementation (path-style, vendor-neutral). |
| `src/storage/ensure.ts` | `ensureCouchDbs` — creates the DB, upserts every design doc, creates the Mango index. |

## Configuration (`config.ts`)

Two layers, per [configuration.md](configuration.md): non-secret defaults from the
repo-root `claude-transcripts.config.json` (DB/bucket names, `features`, `servicesMenu`),
overlaid with secrets/endpoints from `.env`.

- **CouchDB:** `COUCHDB_HOST/PORT/USER/PASSWORD`, `COUCHDB_DB` (or
  `claude-transcripts.config.json` → `couchdb.database`).
- **S3:** `S3_ENDPOINT` (full URL), `S3_REGION` (Garage default `garage`),
  `S3_ACCESS_KEY`, `S3_SECRET_KEY`, `S3_BUCKET` (or `s3.bucket`).
- **webapi:** `WEBAPI_HOST`/`WEBAPI_PORT` (default `127.0.0.1:7650`),
  `CT_STATIC_DIR` (optional — enables SPA serving), `CT_VERSION` (baked at
  image build from the git tag; surfaced on `/health`).

## HTTP API

All session endpoints are under `/api/claude`. Routes are declared with
`createRoute(...)` + zod schemas so the OpenAPI spec and Swagger UI are generated
from the same definitions (no hand-written spec).

| Method | Path | Query | Returns |
|--------|------|-------|---------|
| `GET` | `/health` | — | `{ ok, status, version }` |
| `GET` | `/api/claude/sessions` | `limit=50`, `skip=0` | `{ sessions: ClaudeSessionSummary[], totalCount }` |
| `GET` | `/api/claude/sessions/{id}` | — | `ClaudeSessionSummary` (404 if absent) |
| `GET` | `/api/claude/sessions/{id}/transcript` | `limit=100`, `offset=0` | `{ messages: object[], totalCount, hasMore }` |
| `GET` | `/api/openapi.json` | — | OpenAPI 3.0 spec |
| `GET` | `/api/doc` | — | Swagger UI |
| `GET` | `/*` | — | SPA static + `index.html` fallback (**only when `CT_STATIC_DIR` is set**) |

### List behaviour (running-session detection)

Ended sessions come from the `sessions/by_date` view, newest-first, paged by
`limit`/`skip`. On the **first page only** (`skip=0`), the route also surfaces
**active** sessions — entries that have a `SessionStart` (via
`session_meta/start_meta`) but **no** `summary:` doc, bounded to starts within the
last 36 h. Each is classified `running` if it logged activity within 15 min, else
`incomplete`. This matches the status model in [architecture.md](architecture.md).

### Detail / transcript

- **Detail** fetches the `summary:<id>` doc. If a transcript blob exists in S3 but
  the summary lacks `token_usage`, it computes it on the fly with
  `sumTranscriptTokens` (see shared, below).
- **Transcript** streams `<id>/transcript.jsonl` from S3 and returns a page of
  parsed JSONL lines (`limit`/`offset` over lines, with `hasMore`). The transcript
  lives in **S3 only** ([ADR 0014](decisions/0014-transcripts-live-in-s3-only.md));
  there is no CouchDB-attachment fallback.

## Storage

- **CouchDB** (`couch.ts`): `nano` against `http://[user:pass@]host:port`, database
  from config. Returns a server scope (DB create) + a document scope (queries).
- **S3** (`s3-blob-store.ts`): `Bun.S3Client` with `endpoint`/`region`/keys from
  config, **path-style** addressing (required by Garage/MinIO). The webapi only
  **reads** blobs (`get` returns a stream, `stat` returns size/etag or `null` on
  404); it never creates the bucket. Swapping Garage → MinIO/R2/AWS is an env
  change only ([ADR 0003](decisions/0003-vendor-neutral-s3-drop-minio-and-rclone.md),
  [ADR 0008](decisions/0008-garage-s3-object-store.md)).

## Schema setup on boot (`ensure.ts`)

`ensureCouchDbs` runs every boot and is idempotent: it creates the database
(ignoring "already exists"), **upserts** every design doc (carrying `_rev`
forward to avoid conflicts), and creates a Mango index on `type` (non-fatal on
error). The design docs it applies are the **webapi mirror** of the hook's
`hooks/couchdb/` designs — the two must stay in sync (a key invariant; see
[CLAUDE.md](../CLAUDE.md)). The full view catalogue is documented in
[couchdb.md](couchdb.md).

## SPA serving (prod)

In production the combined image sets `CT_STATIC_DIR` to the built SPA
(`packages/webui/dist`); `server.ts` then serves static files with an
`index.html` fallback for client-side (hash) routing — one container serves API +
UI ([ADR 0002](decisions/0002-single-combined-container.md)). In dev the var is
unset and Vite serves the UI, proxying `/api` to this service.

## `packages/shared`

`packages/shared/src/index.ts` holds cross-cutting domain types + helpers. The
wire/response types are currently imported directly by the webui, but the
**direction** is for webui + CLI to consume a client **generated from the OpenAPI
spec** ([ADR 0019](decisions/0019-openapi-source-of-truth-generated-clients.md),
superseding 0006), leaving `shared` for genuinely cross-cutting domain types like
`sumTranscriptTokens`:

- **Types:** `TokenUsage`, `SessionStatus` (`"ended" | "running" | "incomplete"`),
  `ClaudeSessionSummary`, `ClaudeSessionsResponse`, `ClaudeTranscriptResponse`.
- **`sumTranscriptTokens(jsonl)`** — sums Anthropic token usage from a transcript,
  **deduplicating by `message.id`** (keeping the heaviest usage block per id) so
  streamed/snapshotted duplicates aren't double-counted. This function is kept
  **byte-identical** with `hooks/scripts/transcript-tokens.ts` (the hook can't
  resolve the workspace at install time) — change both together.

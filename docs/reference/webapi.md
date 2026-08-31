# webapi — codebase reference

A [Hono](https://hono.dev) + Bun service that reads sessions back out of CouchDB +
S3, exposes them over a small JSON API, and (in production) serves the built
`webui` SPA from the same process. **As built today it is read-only** for session
data (the only writes it does are idempotent schema setup on boot).

> **Direction** ([ADR 0016](../design/decisions/0016-webapi-is-the-io-gateway.md)): the
> webapi is the project's **single I/O gateway and stability column** — the hook
> and all consumers will read *and write* through it, and it will add read-only
> `/api/couch` + `/api/s3` proxies. This doc describes the current code; see
> [architecture.md](../design/architecture.md) and [routes.md](routes.md) for the target.

- **Package:** `packages/webapi/` (workspace name `@claude-transcripts/webapi`)
- **Runtime:** Bun, TypeScript (ESM, strict)
- **Framework:** Hono via [`@hono/zod-openapi`](https://github.com/honojs/middleware/tree/main/packages/zod-openapi) (OpenAPI-typed routes) + `@hono/swagger-ui`
- **CouchDB client:** [`nano`](https://github.com/apache/couchdb-nano)
- **S3 client:** Bun's built-in `Bun.S3Client` (no SDK dependency)

> **API docs tooling (decided).** **Keep the OpenAPI spec** — it's the contract
> source of truth and `orval` needs it to generate the CLI + webui clients
> ([ADR 0019](../design/decisions/0019-openapi-source-of-truth-generated-clients.md)). The
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
| `src/storage/session-index.ts` | Per-session aggregates held in memory, patched from the change feed — what makes the session list fast. |
| `src/storage/changes-follower.ts` | Follows CouchDB `_changes`; feeds the session index (always) and Meilisearch (when search is on). |

## Configuration (`config.ts`)

Two layers, per [configuration.md](../start/configuration.md): non-secret defaults from the
repo-root `claude-transcripts.config.json` (DB/bucket names, `features`, `servicesMenu`),
overlaid with secrets/endpoints from `.env`.

- **CouchDB:** `COUCHDB_URL` (full base URL; https + path prefix supported, wins
  over `COUCHDB_HOST/PORT`), `COUCHDB_HOST/PORT/USER/PASSWORD`, `COUCHDB_DB` (or
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
| `GET` | `/health` | — | `{ ok, status, version, startedAt, stores }` — see below |
| `GET` | `/api/claude/sessions` | `limit=50`, `skip=0` | `{ sessions: ClaudeSessionSummary[], totalCount }` |
| `GET` | `/api/claude/sessions/{id}` | — | `ClaudeSessionSummary` (404 if absent) |
| `GET` | `/api/claude/sessions/{id}/transcript` | `limit=100`, `offset=0` | `{ entries: TranscriptEntry[], totalCount, hasMore, source, byteCoverage }` |
| `POST` | `/api/search/reindex` | — | `{ enabled, sessions: {scanned, indexed}, turns: {scanned, indexed}, failures }` |
| `GET` | `/api/openapi.json` | — | OpenAPI 3.0 spec |
| `GET` | `/api/doc` | — | Swagger UI |
| `GET` | `/*` | — | SPA static + `index.html` fallback (**only when `CT_STATIC_DIR` is set**) |

### Health and store readiness

`/health` answers two questions that are easy to conflate:

- **Is the process alive?** It always returns **HTTP 200** while it is. Callers
  that only want liveness (the e2e suite, container probes) can keep using the
  status code.
- **Are its stores usable?** The body carries that: `ok: false` and
  `status: "degraded"` when the sessions database can't be reached, with
  `stores.couch.error` explaining why (missing database, rejected credentials,
  unreachable server) and `stores.couch.provisioned` reporting whether boot-time
  provisioning — database creation plus [migrations](../operate/migrations.md) —
  completed, with `provisioningError` when it didn't.
- **Is the session list being served from memory?** `sessionIndex` reports
  `ready`, how many `sessions` are held, when it last fully `loadedAt` and was last
  patched (`updatedAt`), and any `error`. `ready: false` means the list is querying
  CouchDB directly — correct, but slow. This is reported because a stale index is
  otherwise invisible: the list keeps answering, just with an older set.

Boot deliberately never blocks on the stores ([index.ts](../../packages/webapi/src/index.ts)):
the webapi must come up so you can *see* what is wrong. That makes this
distinction load-bearing — without it, a webapi with no databases is
indistinguishable from a healthy one until the first write fails. `cli doctor`
checks it before writing anything.

### List behaviour (running-session detection)

Ended sessions come from the `sessions/by_date` view, newest-first, paged by
`limit`/`skip`. On the **first page only** (`skip=0`), the route also surfaces
**active** sessions — entries that have a `SessionStart` (via
`session_meta/start_meta`) but **no** `summary:` doc, bounded to starts within the
last 36 h. Each is classified `running` if it logged activity within 15 min, else
`incomplete`. This matches the status model in [architecture.md](../design/architecture.md).

### Detail / transcript

- **Detail** fetches the `summary:<id>` doc. If a transcript blob exists in S3 but
  the summary lacks `token_usage`, it computes it on the fly with
  `sumTranscriptTokens` (see shared, below).
- **Transcript** reads from the **CouchDB `chunk` docs by default**, via
  `chunks/entries_by_session` (turns keyed `[session_id, byte_start, entry_index]`,
  i.e. transcript order across all speakers), paged at the view by `limit`/`offset`.
  Because chunks are flushed *mid-session*, this serves a **live** session's
  transcript-so-far — it no longer waits for the SessionEnd upload, which is why a
  session that crashed before finalising is still readable.

  The S3 blob (`<id>/transcript.jsonl`) is the fallback, used when it reaches
  further than the chunks: for a session logged with `couchFullContentChunks` off
  (byte-range-only chunks carry no turns), or when a final flush was missed so the
  last chunk falls short of the uploaded file. The rule is *whichever source covers
  more bytes, chunks winning ties* — identical for an ended or backfilled session,
  chunks for a live one. The response reports which store answered (`source`:
  `chunks` | `s3`) and how far it reaches (`byteCoverage`).

  Both sources normalise to the same pruned per-turn shape
  ([ADR 0027](../design/decisions/0027-full-content-chunks-in-couchdb.md)), so the response
  never changes form with `source`. That means the endpoint no longer returns raw
  Claude Code JSONL — byte-exact lines remain available through the read-only S3
  proxy (`/api/s3/sessions/<id>/transcript.jsonl`). This narrows
  [ADR 0014](../design/decisions/0014-transcripts-live-in-s3-only.md): S3 is still
  the durable, byte-faithful home, but it is no longer the *read* path.

  A 502 (rather than 404) distinguishes "nothing in CouchDB and S3 itself failed"
  from "no transcript stored".

### Search indexes (derived state)

Two Meilisearch indexes, named from `config/` (`meilisearch.indexes`, namespaced so a
shared engine can't collide — [ADR 0028](../design/decisions/0028-external-vs-bundled-meilisearch.md)):
`claude-transcripts-sessions` (one doc per session, metadata search) and
`claude-transcripts-turns` (one doc per conversation turn, content search).

They are **derived** — everything in them is a projection of CouchDB, so losing the
engine costs a `reindex`, not data. Three write paths keep them current:

- **The ingest routes** index as they write, so `backfill` / `import` / `doctor` are
  searchable immediately.
- **A CouchDB `_changes` follower** catches everything else — including the hook's
  direct writes, which never touch the webapi. It checkpoints its sequence, so a
  restart resumes rather than replaying; its *first* run starts at `now`, because
  bulk-loading an existing corpus is far cheaper via `reindex`.

  The checkpoint is a **local document** (`_local/search_checkpoint`), which is not a
  detail: CouchDB keeps local docs out of `_changes`, and an ordinary doc there made
  the follower wake itself — the checkpoint write was a change, the batch held nothing
  indexable, and it checkpointed again, about ten times a second forever (#89). An
  instance upgrading from an earlier version adopts the old doc's position on first
  boot and deletes it.
- **`POST /api/search/reindex`** (`cli reindex`) clears and rebuilds. The reconciliation
  step for history that predates search, for an index rename, and for deletes.

Worth knowing: only conversation turns (`user`/`assistant`/`tool_result`) enter the
turns index. Non-message lines carry a display summary but are deliberately not
indexed — they're context, not content, and there are more of them than user turns.
Deleting a session through `DELETE /api/ingest/{id}` removes its search entries too.

Two Meilisearch behaviours the write path has to respect:

- **Document ids accept only `a-zA-Z0-9`, `-` and `_`.** Build them with
  `searchDocId()`, never by joining parts with a separator like `:`. Ids must also be a
  pure function of their parts so re-ingesting a chunk *replaces* its turns.
- **Validation is asynchronous.** `POST /documents` answers `202 Accepted` and rejects
  the batch later, in the task queue, so an invalid batch is indistinguishable from
  success at the call site. Ingest accepts that (search must never break a write); the
  reindex path instead waits on the tasks and surfaces failures. If an index is
  unexpectedly empty, read `GET /tasks` on Meilisearch — that is where the error is.

## Storage

- **CouchDB** (`couch.ts`): `nano` against `http://[user:pass@]host:port`, database
  from config. Returns a server scope (DB create) + a document scope (queries).
- **S3** (`s3-blob-store.ts`): `Bun.S3Client` with `endpoint`/`region`/keys from
  config, **path-style** addressing (required by Garage/MinIO). The webapi only
  **reads** blobs (`get` returns a stream, `stat` returns size/etag or `null` on
  404); it never creates the bucket. Swapping Garage → MinIO/R2/AWS is an env
  change only ([ADR 0003](../design/decisions/0003-vendor-neutral-s3-drop-minio-and-rclone.md),
  [ADR 0008](../design/decisions/0008-garage-s3-object-store.md)).

## Schema setup on boot (`ensure.ts`)

`ensureCouchDbs` runs every boot and is idempotent: it creates the databases
(ignoring "already exists") and creates a Mango index on `type` (non-fatal on error),
then applies any **pending migrations**.

The design docs come from the migration registry
(`@claude-transcripts/shared` `src/migrations/`) and nowhere else — there is one
authoritative definition, applied through the versioned path rather than upserted
blindly, so a view can never drift from the document shapes it maps over
([migrations.md](../operate/migrations.md)). The full view catalogue is documented in
[couchdb.md](couchdb.md).

## SPA serving (prod)

In production the combined image sets `CT_STATIC_DIR` to the built SPA
(`packages/webui/dist`); `server.ts` then serves static files with an
`index.html` fallback for client-side (hash) routing — one container serves API +
UI ([ADR 0002](../design/decisions/0002-single-combined-container.md)). In dev the var is
unset and Vite serves the UI, proxying `/api` to this service.

### Compression and caching

`src/caching.ts` supplies both, and `server.ts` mounts them.

**Compression** wraps hono's `compress()` and applies to every response, API JSON
included. The wrapper exists because the stock middleware, on Bun, never sets `Vary:
Accept-Encoding` and cannot honour its own size threshold — Hono responses arrive
without a `Content-Length` to test, so *every* response was encoded, including short
ones that got bigger in the process. The wrapper sizes the body itself and hands a
small one back untouched with a real `Content-Length`. Binary bodies (the CLI
download, proxied blobs) and `text/event-stream` are excluded by content type;
CouchDB change feeds proxied through `/api/couch?feed=continuous` are excluded
explicitly, because buffering one into compression blocks would stall it.

The middleware must be registered **before** the routes it wraps. A `use("*")` added
afterwards matches nothing, and the only symptom is that responses come back
uncompressed.

**Caching** turns on whether a file's URL changes when its bytes do:

| Served from | `Cache-Control` | ETag |
|---|---|---|
| `/app/assets/*` — Vite's content-hashed bundles | `public, max-age=31536000, immutable` | no |
| `/app/*` — the `index.html` shell | `no-cache` | yes |
| `/docs/*` — never content-hashed | `no-cache` | yes |

The split is by **directory**, not by the shape of a filename: Vite writes hashed
artefacts to `assets/` and leaves the shell and anything from `public/` unhashed, and
the docs build has an `assets/` directory of its own that is *not* hashed. An ETag is
computed only where a client will actually revalidate — hashing a 670 KB bundle on
every request to produce a header no client will ever send back is pure cost.

## The session index

`GET /api/sessions` needs one aggregate row per session, and gets it from
`session_index/aggregate` — a view whose reduce is **JavaScript**. CouchDB can serve
a reduce from the values stored in its btree nodes only when a node's whole span
falls inside one group; grouped per session it never does, so each request pushed
essentially the entire corpus back through the `couchjs` query server. Measured on a
real instance: **~20 ms per session, every request**, which at 463 sessions and 49 k
documents made the landing page an 8-second wait ([#107](https://github.com/vredchenko/claude-transcripts/issues/107)).

`src/storage/session-index.ts` stops asking. A session's rollup changes only when
that session gets new documents, and `_changes` says exactly which sessions those
are — so the grouped query runs **once** at boot, and after that only the sessions a
change batch touched are re-read (`keys=[…]`). The route then filters, sorts and
paginates in memory, which is what it already did with the view's rows.

|  | before | after |
|---|---|---|
| `GET /api/sessions?limit=50` | 8,000–8,700 ms | **5–70 ms** |
| one change batch touching a session | — | ~95 ms |
| full (re)load | — | ~8 s, at boot and every 15 min |

Three properties it is built to keep:

- **It is a cache, not a source of truth.** Rows are stored exactly as the view
  returns them, and every judgement about what a row *means* stays in the route.
  `POST /api/search/reindex` deliberately still queries CouchDB: it is the
  reconciliation path, and rebuilding one cache from another could not detect the
  drift it exists to fix.
- **It fails soft.** While cold, and after any failed load, `ready` is false and the
  route queries the view exactly as before. A broken index costs latency, never
  correctness — and a failed *re*load keeps serving the last good answer rather than
  an empty one.
- **It self-heals.** The change feed is the update path, but a feed that died would
  leave a silently stale list, so a full reload runs every 15 minutes as a backstop
  and `/health` reports the index's state.

Because the index needs the feed, `changes-follower.ts` runs even when Meilisearch is
off — one feed with two consumers rather than two feeds learning the same facts.

## `packages/shared`

`packages/shared/src/index.ts` holds cross-cutting domain types + helpers. The
wire/response types are currently imported directly by the webui, but the
**direction** is for webui + CLI to consume a client **generated from the OpenAPI
spec** ([ADR 0019](../design/decisions/0019-openapi-source-of-truth-generated-clients.md),
superseding 0006), leaving `shared` for genuinely cross-cutting domain types like
`sumTranscriptTokens`:

- **Types:** `TokenUsage`, `SessionStatus` (`"ended" | "running" | "incomplete"`),
  `ClaudeSessionSummary`, `ClaudeSessionsResponse`, `ClaudeTranscriptResponse`.
- **`sumTranscriptTokens(jsonl)`** — sums Anthropic token usage from a transcript,
  **deduplicating by `message.id`** (keeping the heaviest usage block per id) so
  streamed/snapshotted duplicates aren't double-counted. One definition, imported by
  the webapi and by the CLI's hook alike — the hook's byte-identical copy was retired
  when the CLI became the hook ([ADR 0004](../design/decisions/0004-bun-monorepo-hook-as-standalone-plugin.md)).

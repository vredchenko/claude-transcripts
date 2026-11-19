# webapi

The web API is the instance's I/O gateway
([ADR 0016](../design/decisions/0016-webapi-is-the-io-gateway.md)): consumers read
through it and write only via `/api/ingest/*`, `/api/migrate/*` and
`/api/search/reindex` — the hook included, which records every session through
`/api/ingest/*`. It follows CouchDB's `_changes` feed so that every write, by any
route, reaches the search index on one path. In production it also serves the web UI,
these docs and the CLI binary.

This page is how it behaves and how to configure it. A first look at it as a client:
[The API](../use/api.md). URL list: [routes.md](routes.md). How it is built:
[`packages/webapi/README.md`](../../packages/webapi/README.md).

## Configuration

Settings from `config/config.json`, else the template (`CT_CONFIG_DIR` overrides the
directory); secrets and endpoints from the environment
([configuration.md](../start/configuration.md)).

| Variables | Default |
|-----------|---------|
| `COUCHDB_URL`, or `COUCHDB_HOST` + `COUCHDB_PORT`; `COUCHDB_USER`, `COUCHDB_PASSWORD` | `http://127.0.0.1:7652` |
| `S3_ENDPOINT`, `S3_REGION`, `S3_ACCESS_KEY`, `S3_SECRET_KEY` | `http://127.0.0.1:7653`, `garage` |
| `MEILI_HOST`, `MEILI_API_KEY` (used only when `features.meilisearch` is on) | `http://127.0.0.1:7656` |
| `WEBAPI_HOST`, `WEBAPI_PORT` | `127.0.0.1:7650` |
| `CT_STATIC_DIR`, `CT_DOCS_DIR`, `CT_CLI_BIN`, `CT_DOWNLOADS_DIR` | unset; each enables `/app`, `/docs`, `/cli/download`, `/downloads/` |

The version `/health` and the OpenAPI document report is not configurable: it is the
lockstep version in `package.json`, spelled `vX.Y.Z`.

## HTTP API

The typed routes (`/api/sessions*`, `/api/turns`, `/api/search*`, `/api/ingest/*`,
`/api/migrate/*`) have an OpenAPI spec generated from the code. Their parameters and
response shapes are documented only there: browse `/api/docs`, or read
`/api/openapi.json`. Validation failures return `400 { error }`.

Plain routes, not in the spec: `/health`, `/`, `/api/blueprint*`, the `/api/couch/*`,
`/api/s3/{bucketKey}/*` and `/api/fossil/{repoKey}/json/*` proxies (GET/HEAD only),
`/api/docs`, `/api/openapi.json`, `/app/*`, `/docs/*`, `/cli/download`.

`/api/fossil/{repoKey}/json/<command>` reads the repository named by
`fossil.repositories.<repoKey>` through Fossil's [JSON API](https://fossil-scm.org/home/doc/trunk/www/json-api/index.md),
e.g. `/api/fossil/sessions/json/timeline/checkin?limit=20`. GET alone doesn't make it
read-only — the JSON API takes parameters from the query string, so `/json/user/save?…`
writes — so only allowlisted commands pass (`version`, `stat`, `whoami`, `cap`,
`resultCodes`, `timeline`, `artifact`, `dir`, `finfo`, `diff`, `branch/list`,
`tag/list|find`, `wiki/list|get|diff`, `report/list|get|run`); anything else, a bare
`/json?command=…` or a `jsonp` parameter is a 403. No client header is forwarded.

### Health

`GET /health` always returns 200 while the process is up, so probes can use the status
code for liveness. The body answers whether the stores are usable:

```
{ ok, status, version, startedAt, stores, sessionIndex }
```

- `ok: false`, `status: "degraded"` when the sessions database can't be reached;
  `stores.couch.error` says why, and `stores.couch.provisioned` /
  `provisioningError` report whether boot-time database creation and migrations
  finished.
- `sessionIndex` reports `ready`, the number of `sessions` held, `loadedAt`,
  `updatedAt` and any `error`. `ready: false` means the list is being served straight
  from CouchDB: correct but slow.

Boot never waits for the stores, so the webapi comes up even when they are broken and
`/health` can say what is wrong. `doctor` checks it before writing anything.

### Session list

Rows come from the `session_index/aggregate` view, one per `session_id`. A session with
a `summary` doc is `ended` (unless the summary was reconciled and events have arrived
since); otherwise `running` if its last event is within
`system.sessions.liveWindowMs` (2 h), else `incomplete`. Filters (`cwd`, `model`,
`hostname`, `source`, `status` exact; `from`/`to` by overlap) apply before paging, and
`totalCount` is the filtered count. The `model` filter matches any model the session
used (search's does too); `cwd` matches the directory it started in.
Each row also lists `models`, `cwds` and `addedDirs`, everything the session used in
order of first use, and carries `activeMs`: the session's span
minus gaps longer than `idleThresholdMs`, from `session_index/event_times`.

The list is served from an in-memory copy of that view, kept current from the change
feed, and falls back to querying CouchDB while the copy is cold or after a failed
load. `/health` reports its state. The change follower therefore runs even with
Meilisearch off.

### Transcripts

`GET /api/sessions/{id}/transcript` reads from the CouchDB chunk docs by default
(`chunks/entries_by_session`, paged at the view), so a running or crashed session is
readable before `SessionEnd`. It falls back to the S3 blob when that covers more bytes:
sessions recorded without full-content chunks, or a missed final flush. The response
reports `source` (`chunks` or `s3`) and `byteCoverage`. Both sources are normalised to
the same pruned per-turn shape, so raw JSONL is available only through
`/api/s3/sessions/<id>/transcript.jsonl`. A 502 means CouchDB had nothing and S3
failed; a 404 means no transcript is stored.

Session detail reads `summary:<id>` and, when `token_usage` is missing but a transcript
exists, computes it from the transcript.

### Search

Three Meilisearch indexes named in `meilisearch.indexes`: sessions (metadata, one doc per
session), and turns split in two — `liveTurns` for running sessions and `turns`, the
archive, for ended ones ([ADR 0032](../design/decisions/0032-live-and-archive-turn-indexes.md)).
A turn doc is one user, assistant or tool-result turn; other transcript lines aren't
indexed. `GET /api/search` queries both turn indexes as one federated search
(Meilisearch 1.10+). All three are derived from CouchDB and kept current two ways:

- the `_changes` follower indexes every write, whether it came through the ingest
  routes or from the hook. It buffers changes and flushes every
  `system.search.flushIntervalMs` (20 s), one update each to the sessions and live
  turns indexes — never the archive. It flushes early when a live session ends or when
  2000 rows are buffered. It checkpoints in the local document
  `_local/search_checkpoint` (local docs don't appear in `_changes`, so the checkpoint
  can't wake the follower) only after a flush, so a crash replays whatever was
  buffered. A flush that fails is logged and its rows are dropped; the checkpoint still
  moves past them. On first run the follower starts at "now".
  Every `system.search.archiveIntervalMs` (15 min) a maintenance pass promotes the
  sessions that ended (any summary: live, reconcile or backfill) or went quiet past the
  live window: their turns are read from CouchDB, added to the archive, and deleted from
  the live index once Meilisearch confirms the add. The pass also checks which sessions
  the live index holds, so a promotion lost to a restart is picked up, and rebuilds the
  live index from CouchDB every `system.search.liveRebuildIntervalMs` (1 h);
- `POST /api/search/reindex` (`claude-transcripts reindex`) rebuilds all three, for
  history that predates search, renamed indexes, deletes and failed flushes. Each index
  is filled under `<name>-rebuild` and swapped in, so search keeps answering meanwhile.
  Unlike the follower it waits on Meilisearch's tasks and reports failures.

`DELETE /api/ingest/{id}` also removes the session's search entries, directly: the
follower handles upserts only.

Meilisearch validates batches asynchronously (`202 Accepted`, then failure in the task
queue): if an index is unexpectedly empty, check `GET /tasks` on Meilisearch.
The follower prunes finished tasks on this deployment's own indexes once they are older
than `system.search.taskRetentionMs` (1 h), so look soon after the failure. It doesn't
touch other indexes' tasks on a shared instance.

### Reconcile sweep

The follower also finalises sessions that never fired `SessionEnd`. Every `system.sessions.reconcile.intervalMs` (1 h)
it takes up to `batchSize` (50) sessions that read as `incomplete` from the session
index, oldest first, and runs the `reconcile-session` action's CLI command —
`claude-transcripts reconcile <ids> --webapi <self> --json` — with the bundled binary
(`CT_CLI_BIN`), or the workspace CLI in a checkout. The summary comes back through
`POST /api/ingest/summary` like any other write. A session the command fails on is held
back until restart. Off with `system.sessions.reconcile.follower: false`
([tools.md](../operate/tools.md#reconcile)).

## Boot and storage

- **Boot** is idempotent and never waits for the stores. It creates CouchDB's system
  databases and every configured database, applies pending
  [migrations](../operate/migrations.md), creates a Mango index on `type`, then starts
  the session index and the change follower (which starts the reconcile sweep).
- **CouchDB** databases are opened by their logical key in `couchdb.databases`, never
  by deployed name.
- **S3** uses path-style addressing (Garage, MinIO), so switching provider is an
  environment change. Writes happen only via `PUT /api/ingest/{id}/transcript` and
  `DELETE /api/ingest/{id}?blobs=true`. The webapi never creates the bucket.

## Serving the web UI and docs

With `CT_STATIC_DIR` set, the web UI is served under `/app/` with an `index.html`
fallback for client-side routes; with `CT_DOCS_DIR` set, these docs are served under
`/docs/`. Responses are compressed. `/app/assets/*` (content-hashed) is cached as
immutable; the web UI's shell and `/docs/*` revalidate with an ETag.

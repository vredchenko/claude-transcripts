# Architecture

```
                         ┌─────────────── webapi (the I/O gateway) ───────────────┐
 Claude Code ──hook──►   │  /api  app endpoints   /api/couch ▶ /api/s3 ▶ (R/O)    │
   (session)             │  the single writer + the stability column              │
   webui ─┐              └───┬───────────────┬───────────────┬───────────────────┘
   CLI  ──┼─ HTTP clients ───┘               │               │
   agents─┘                              CouchDB           Garage (S3)        Meilisearch
                                      (source of truth)  (blobs/escrow)    (derived search)
```

**Everything goes through the webapi** ([ADR 0016](decisions/0016-webapi-is-the-io-gateway.md)):
the hook writes through it, and the webui, CLI, and agents read/write through it.
The webapi is **non-optional** — the *stability column* whose contract holds even
as internals change. It transparently proxies, **read-only**, to CouchDB
(`/api/couch`) and S3 (`/api/s3`) where their native API is itself a useful
surface; **writes are never proxied** — they go through curated endpoints that own
the document/blob shapes. See [routes.md](routes.md) and [tiers.md](tiers.md).

> **Core vs optional:** webapi + CouchDB are core. webui, CLI, Meilisearch, and S3
> are optional/removable — losing one degrades a feature (UI, terminal/agent UX,
> search, blob backups), never the system. Graceful degradation is a first
> principle. Full breakdown in [tiers.md](tiers.md).

## Components

| Path | What it is |
|------|-----------|
| `hooks/` | Claude Code plugin. `scripts/dispatch.ts` is registered for every hook event and fans out to per-event handler modules in `scripts/handlers/` (shared helpers in `scripts/lib/`). Writes events/summaries to CouchDB and transcript/summary blobs to S3. Standalone Bun scripts; installs separately from the app. |
| `packages/shared/` | Types + `sumTranscriptTokens` shared by the webapi. The hook keeps a byte-identical copy (it can't resolve the workspace at plugin-install time). |
| `packages/webapi/` | Hono + Bun read API. Auto-creates the CouchDB DB + design docs on boot. Reads sessions/transcripts; serves the built SPA in prod. |
| `packages/webui/` | React + Vite + MUI SPA. Session list, detail, transcript viewer. |
| `deploy/` | docker-compose stack (CouchDB + Garage + Meilisearch + app). |

## Data model (CouchDB `claude-sessions`)

- **event docs** (`type: "event"`) — one per hook event, POSTed live.
- **summary docs** (`_id: "summary:<sessionId>"`, `type: "summary"`) — written at
  `SessionEnd`, carrying counts, `tool_counts`, `token_usage`, and
  `transcript_bytes` (the transcript's size; its content lives in S3 only — never
  in CouchDB, see [ADR 0014](decisions/0014-transcripts-live-in-s3-only.md)).

Design docs (mirrored in `hooks/couchdb/` and `packages/webapi/src/storage/ensure.ts`):

- `sessions/by_date`, `sessions/by_cwd`
- `events/by_session`, `events/by_type`
- `tools/usage`, `tools/failures`, `tools/errors`
- `activity/timeline`
- `session_meta/start_meta` (running-session enrichment), `session_meta/tokens_by_date`

Blobs live in S3 under `<bucket>/<sessionId>/{summary.json,transcript.jsonl}` —
the transcript's sole durable home. The webapi reads transcripts from S3 only.

## Session status

A session is `ended` once its summary doc lands. Before that it has only a
`SessionStart` event: `running` if it logged activity within 15 min, else
`incomplete` (died without a `SessionEnd`). Active sessions are surfaced on the
first page only, bounded to starts from the last 36 h.

## Storage decisions

- **CouchDB** — document store + map/reduce views (event + summary docs only;
  transcript bytes never go in CouchDB).
- **Garage** — vendor-neutral S3 for durable transcript/summary blobs. Accessed
  via Bun's built-in `S3Client`, so MinIO / R2 / AWS work by changing env only.
- **Meilisearch** — provisioned in the stack for phase-2 full-text search; not
  used yet.

> Phase 1 recreates the prior multi-repo logging + viewer as one standalone
> project. Search (Meilisearch wiring) and the items in [roadmap.md](roadmap.md)
> are deliberately out of scope here.

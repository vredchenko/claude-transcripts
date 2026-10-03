# CouchDB documents and views

CouchDB is the primary store ([ADR 0007](../design/decisions/0007-couchdb-primary-store.md)).
The sessions database (`claude-transcripts-sessions` by default) holds typed,
append-only documents; map/reduce design views do the aggregation. The byte-exact
transcript lives in S3 ([ADR 0014](../design/decisions/0014-transcripts-live-in-s3-only.md));
CouchDB holds parsed, pruned turns on full-content chunks
([ADR 0027](../design/decisions/0027-full-content-chunks-in-couchdb.md)).

## Conventions

- **Append-only.** New information is a new doc; existing docs are not edited. This
  keeps future replication conflict-free.
- **Every doc has `type` and an explicit `timestamp`**, since CouchDB records no
  wall-clock time.
- **Keyed by Claude Code's own `session_id`** (a UUID), so a session has the same
  identity on every machine.
- **Stable ids where identity matters**: `summary:<sessionId>`,
  `chunk:<sessionId>:<byte_start>`. Event docs get CouchDB-assigned ids.
- **Schemas live in code**: zod validators in `packages/webapi/src/routes/ingest.ts`
  check documents written through the webapi. Ingested docs are built in
  `packages/cli/src/lib/session-docs.ts`; the hook builds its own in
  `packages/cli/src/hook/handlers.ts` and writes them directly, so they are **not**
  validated on write.
- **Views tolerate older or foreign docs** by coalescing missing fields.

## Document types

| `type` | `_id` | Written by | Status |
|--------|-------|-----------|--------|
| `event` | auto | the hook, per event; `backfill` | written |
| `summary` | `summary:<sessionId>` | the hook at `SessionEnd`; `backfill`; `doctor` | written |
| `chunk` | `chunk:<sessionId>:<byte_start, zero-padded to 12>` | the hook mid-session; `backfill` | written |
| `schema_version` | `schema_version` | the migration runner | written |
| — | `_local/search_checkpoint` | the webapi's search follower | written (a local doc: not in `_all_docs`, `_changes` or replication) |
| `session_start` | `session_start:<sessionId>` | — | planned: a start record with session metadata |
| `meta` | auto | — | planned: append-only enrichment (attribution, tags, extracted facts) |
| `log` | auto, in the separate app-logs database | — | planned ([app-logging.md](../operate/app-logging.md)) |

### `event`

```jsonc
{
  "type": "event",
  "event": "PostToolUse",          // hook event name
  "session_id": "<uuid>",
  "timestamp": "2026-06-18T12:34:56.789Z",
  "hostname": "…",
  "cwd": "/abs/path"
}
```

Plus, per event (previews are capped at 200 characters; full content is in chunks and
S3):

| `event` | Extra fields |
|---------|--------------|
| `SessionStart` | `source` (`startup`/`clear`/`resume`/`compact`), `model`, `permission_mode` |
| `UserPromptSubmit` | `prompt_length`, `prompt_preview` |
| `PostToolUse` | `tool_name`, `tool_use_id`, `input_preview` |
| `PostToolUseFailure` | `tool_name`, `error_preview`, `is_interrupt` |
| `Stop` | `stop_hook_active` |
| `StopFailure` | `error_type`, `error_preview` |
| `SubagentStart` / `SubagentStop` | `agent_id`, `agent_type` |
| `PreCompact` / `PostCompact` | `trigger` (`manual`/`auto`) |

### `summary`

Written once per session. A session is `ended` exactly when this doc exists.

```jsonc
{
  "_id": "summary:<sessionId>",
  "type": "summary",
  "event": "SessionEnd",
  "session_id": "<uuid>",
  "timestamp": "…", "hostname": "…", "cwd": "/abs/path",
  "end_reason": "…",              // Claude Code's SessionEnd `reason`, else "unknown"
  "event_count": 0, "prompt_count": 0, "error_count": 0,
  "tool_counts": { "Bash": 12, "Edit": 5 },
  "transcript_bytes": 0,          // size only; the transcript is in S3
  "token_usage": { "input": 0, "output": 0, "cacheCreation": 0, "cacheRead": 0, "total": 0, "messages": 0 },
  "system_checks": {},            // hook-written docs; reserved, currently empty
  "source": "live | backfill | doctor",
  "model": "…",                   // backfill/doctor docs, from the transcript
  "backfilled_at": "…",           // backfill only; the session's own time stays in `timestamp`
  "actor": "…"                    // optional, from `backfill --actor`
}
```

`token_usage` is computed by `sumTranscriptTokens`, deduplicated by `message.id`.

### `chunk`

A slice of the transcript, written as the session runs
([mid-flight-chunking.md](../design/mid-flight-chunking.md)) or reconstructed by
`backfill`. Both use the shared `sliceIntoChunks`, so the boundaries match.

```jsonc
{
  "_id": "chunk:<sessionId>:000000010240",
  "type": "chunk",
  "session_id": "<uuid>",
  "byte_start": 10240, "byte_end": 10752,
  "entry_count": 8,
  "timestamp": "…", "hostname": "…", "cwd": "/abs/path",
  "schema_version": 2,            // 2 with entries[], 1 for byte-range only
  "source": "live | backfill | doctor",
  "entries": [ /* parsed, pruned turns, only with couchFullContentChunks */ ]
}
```

Keying on `byte_start` keeps ids unique across resumes. Chunks are not deduplicated at
write time; repeated streaming entries are a read-time concern.

### `schema_version`

```jsonc
{
  "_id": "schema_version",
  "type": "schema_version",
  "version": 10,                  // highest applied migration; 0 = pristine
  "applied": [ { "id": 1, "name": "initial-schema", "at": "2026-06-20T09:14:02.881Z" } ]
}
```

### Status model (derived, not stored)

`ended` if a `summary` doc exists; otherwise `running` or `incomplete` by how recently
the session had activity ([webapi.md](webapi.md#session-list)).

## Design views

All JavaScript map/reduce, all installed by [migrations](../operate/migrations.md) from
`packages/shared/src/migrations/` and applied by the webapi on boot.

| View | Maps | Key → value | Reduce | Used by |
|------|------|-------------|--------|---------|
| `sessions/by_date` | `summary` | `[y, m, d]` → `{ session_id, event_count, prompt_count, error_count, cwd }` | `_count` | `reindex` |
| `sessions/by_cwd` | `summary` | `[cwd, timestamp]` → `{ session_id, event_count, prompt_count }` | `_count` | |
| `events/by_session` | `event` | `[session_id, timestamp]` → `{ event, tool_name, input_preview }` | — | a session's event timeline |
| `events/by_type` | `event` | `[event, y, m, d]` → `1` | `_count` | |
| `tools/usage` | `event` with a `tool_name` | `[tool_name, y, m, d]` → `1` | `_count` | |
| `tools/failures` | `PostToolUseFailure` | `[tool_name, timestamp]` → `{ session_id, error_preview, cwd }` | — | |
| `tools/errors` | `PostToolUseFailure`, or any doc with an `error` field | `[tool_name or "unknown", timestamp]` → same | — | |
| `activity/timeline` | `event` | `[y, m, d, h]` → `1` | `_count` | |
| `chunks/by_session` | `chunk` | `[session_id, byte_start]` → `{ byte_start, byte_end, entry_count }` | — | reassembly |
| `chunks/entry_count_by_session` | `chunk` | `session_id` → `entry_count` | `_sum` | |
| `chunks/entries_by_session` | full-content `chunk` | `[session_id, byte_start, entry_index]` → the turn (`role`, `timestamp`, `text`, `toolUses`, `toolUseId`, `isError`, `isSidechain`, `kind`) | `_count` | `GET /api/sessions/{id}/transcript` |
| `speaker_split/by_role` | full-content `chunk` | `[session_id, role, byte_start, entry_index]` → `{ role, timestamp, text, toolUses, toolUseId, isError }` | `_count` | `GET /api/sessions/{id}/turns` |
| `speaker_split/by_role_time` | full-content `chunk` | `[role, timestamp, session_id, byte_start, entry_index]` → `{ sessionId, cwd, role, timestamp, text }` | `_count` | `GET /api/turns` |
| `session_index/aggregate` | `event`, `summary`, `chunk` | `session_id` → per-doc rollup | custom merge | session list and detail |
| `session_index/event_times` | `event`, `summary`, `chunk` | `session_id` → `timestamp` | — | active duration |
| `session_meta/start_meta` | `SessionStart` events | `session_id` → `{ timestamp, model, cwd, hostname }` | — | unused by the webapi |
| `session_meta/tokens_by_date` | `summary` | `[y, m, d]` → token sums + `sessions` | `_sum` | |

Notes:

- `session_index/aggregate` (`group=true`) returns one bounded object per session, so
  `reduce_limit` is disabled on the bundled CouchDB. `model`, `cwd` and `hostname` come
  from the session's earliest doc carrying each, so the result doesn't depend on how
  CouchDB groups the re-reduce. The webapi caches it in memory
  ([webapi.md](webapi.md#session-index)).
- `entries_by_session` is transcript order across speakers; `by_role` groups by speaker
  and so can't interleave them. Byte-range-only chunks emit nothing to either.
- Planned: feature views (`features/urls`, then repos, PRs, issues, slash commands,
  models) and cross-session timelines.

## Changing a view

Add a migration; never edit a design doc in place. The runner records each step in
`schema_version` and the webapi applies pending steps on boot, so every instance ends
up with the same views.

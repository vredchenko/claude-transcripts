# CouchDB document types, schemas & design views

CouchDB is the **primary store** ([ADR 0007](decisions/0007-couchdb-primary-store.md)):
a single database (`claude-sessions` by default) of heterogeneous, **append-only**
docs, with map-reduce design views doing the aggregation. Full-fidelity transcript
bytes never live here — they go to S3 only
([ADR 0014](decisions/0014-transcripts-live-in-s3-only.md)).

This doc has two halves: **(1) the document types and their schemas**, and
**(2) how the design views bring those documents together** and which views exist.

## Conventions

- **One database, append-only.** Docs are added, effectively never edited in place
  — this keeps the model replication-friendly (the basis of Tier-3 multiplayer,
  [#15](roadmap.md)) and is an invariant ([ADR 0016](decisions/0016-webapi-is-the-io-gateway.md)).
- **Every doc carries a `type` and a `timestamp`.** CouchDB does not stamp
  wall-clock time, so the writer always sets `timestamp`/`ts` explicitly.
- **Stable ids where identity matters** (`summary:<sessionId>`,
  `chunk:<sessionId>:<byte_start>`); event docs are POSTed with a CouchDB-assigned
  id.
- **Keyed by Claude Code's own `session_id`** (a UUID), never a generated one — so
  the same session is addressable across machines.
- Schema changes are handled by versioned [migrations](migrations.md).

---

## 1. Document types & schemas

| `type` | `_id` | Written by | When |
|--------|-------|-----------|------|
| [`event`](#event) | auto | per-event handlers | live, per hook event |
| [`summary`](#summary) | `summary:<sessionId>` | session-end (live) / `backfill` | at session end |
| [`chunk`](#chunk) | `chunk:<sessionId>:<byte_start>` | backfill / chunk-flush | on backfill, or live (chunking on) |
| `session_start` *(planned)* | `session_start:<sessionId>` | session-start | once, at start (#15) |
| `meta` *(planned)* | auto | enrichment endpoint | any time, append-only (#3/#7) |
| `schema_version` *(planned)* | `schema_version` | migrations | on migrate |

> Operational/app logs (`type:"log"`) live in a **separate database**, not this
> one — see [app-logging.md](app-logging.md) / [ADR 0018](decisions/0018-app-logging-into-couchdb.md).

### `event`

One per hook event, POSTed live. Carries the **common fields** stamped on every
event doc, plus event-specific fields.

```jsonc
// common (every event doc)
{
  "type": "event",
  "event": "PostToolUse",        // the hook event name
  "session_id": "<cc uuid>",
  "timestamp": "2026-06-18T12:34:56.789Z",
  "hostname": "…",
  "cwd": "/abs/path"
}
```

Event-specific additions:

| `event` | Extra fields |
|---------|--------------|
| `SessionStart` | `source` (`startup`/`clear`/`resume`/`compact`), `model`, `permission_mode` |
| `UserPromptSubmit` | `prompt_length`, `prompt_preview` (≤200 chars) |
| `PostToolUse` | `tool_name`, `tool_use_id`, `input_preview` (≤200 chars) |
| `PostToolUseFailure` | `tool_name`, `error_preview` (≤200 chars), `is_interrupt` (bool) |
| `Stop` | `stop_hook_active` (bool) |
| `StopFailure` | `error_type`, `error_preview` (≤200 chars) |
| `SubagentStart` / `SubagentStop` | `agent_id`, `agent_type` |
| `PreCompact` / `PostCompact` | `trigger` (`manual`/`auto`) |

(Previews are deliberately short markers; full content lives in chunks/S3. As more
hook types are wired ([hooks.md](hooks.md)), their marker fields are added here.)

### `summary`

Written once at `SessionEnd` by the live hook, or by `backfill` when adopting an
on-disk transcript. A session is **`ended`** iff this doc exists.

```jsonc
{
  "_id": "summary:<sessionId>",
  "type": "summary",
  "event": "SessionEnd",
  "session_id": "<cc uuid>",
  "timestamp": "…",
  "hostname": "…",
  "cwd": "/abs/path",
  "end_reason": "user-input | session-limit | unknown",
  "event_count": 0,
  "prompt_count": 0,
  "error_count": 0,
  "tool_counts": { "Bash": 12, "Edit": 5 },   // tool name → call count
  "transcript_bytes": 0,                        // size only; content is in S3
  "token_usage": {                              // see TokenUsage below
    "input": 0, "output": 0,
    "cacheCreation": 0, "cacheRead": 0,
    "total": 0, "messages": 0
  },
  "system_checks": {},
  "source": "live | backfill",                  // "live" = hook-recorded; "backfill" = adopted transcript
  "backfilled_at": "…"                          // present only on backfilled docs; real session time stays in `timestamp`
}
```

**`TokenUsage`** (shared shape, computed by `sumTranscriptTokens`, deduped by
`message.id`): `input`, `output`, `cacheCreation`, `cacheRead`, `total`,
`messages`.

### `chunk`

Append-only byte-faithful slice of the transcript — reconstructed by `backfill`
(via the shared `sliceIntoChunks`), or written live during the session when
mid-flight chunking is enabled ([mid-flight-chunking.md](mid-flight-chunking.md)).

```jsonc
{
  "_id": "chunk:<sessionId>:<byte_start padded to 12>",
  "type": "chunk",
  "session_id": "<cc uuid>",
  "byte_start": 10240,
  "byte_end": 10752,
  "entry_count": 8,             // non-null parsed JSONL entries in this slice
  "timestamp": "…",
  "hostname": "…",
  "cwd": "/abs/path",
  "schema_version": 1,
  "entries": [ /* parsed, pruned JSONL entries — only when couchFullContentChunks */ ]
}
```

The id is keyed on `byte_start` (monotonic, unique per session) so it never
collides across resumes. Chunks stay byte-faithful to their slice (no dedup at
write time — that's a read/view-time concern), which keeps them append-only and
replication-safe.

### Status model (derived, not stored)

A session's status is **derived**, never written as a field:

- **`ended`** — a `summary:<id>` doc exists.
- **`running`** — a `SessionStart` (via `session_meta/start_meta`) with no summary,
  with activity in the last 15 min.
- **`incomplete`** — started but went quiet without a `SessionEnd`.

### Schemas defined in code

CouchDB is schemaless, but **our** documents have a known, expected shape — so we
**define that shape in code** and treat it as authoritative:

- The doc schemas above are expressed as **TypeScript types + runtime validators**
  (e.g. zod) in a shared module, with a `schema_version` per type.
- The **webapi gateway** validates documents against these schemas on write
  ([ADR 0016](decisions/0016-webapi-is-the-io-gateway.md)) — the single place all
  writes pass through — so malformed docs don't enter the corpus.
- The schemas are **part of the migration process** ([migrations.md](migrations.md),
  [ADR 0021](decisions/0021-self-built-couchdb-migrations.md)): a schema change is a
  versioned migration that bumps `schema_version`, transforms existing docs, and
  updates the design views that map over them — so code, data, and views move
  together.
- **Tolerant of foreign/legacy docs.** CouchDB stays schemaless: docs we didn't
  write (or older versions) are tolerated; views coalesce missing fields to
  sensible defaults (the #7 backward-compat pattern). The code schemas constrain
  *what we write*, not what the database can hold.

> The schema definitions are the same source the webapi's `ensure.ts` and the hook
> reference; keep them aligned with the design-view mirrors (below).

---

## 2. How design views bring documents together

The documents above are a flat, heterogeneous stream. **Design views are what turn
that stream into queries** — they map over docs of a given `type`/`event`, emit
keys that group or order them (by session, by date, by tool, by hour), and
optionally reduce (count/sum). Two patterns recur:

- **Reassembly** — collect all docs for one `session_id` (its events in order, its
  chunks in byte order) to reconstruct a session.
- **Cross-session aggregation** — group across all sessions by date / tool / hour
  to power lists, analytics, and timelines.

The design docs are defined in **two mirrored places that must stay in sync**:
`hooks/couchdb/claude-sessions/designs/*.json` (synced by `setup-views.sh`) and
`packages/webapi/src/storage/ensure.ts` (auto-applied on webapi boot). All views
are JavaScript map/reduce. (The [migration tool](migrations.md) will become the
authoritative path for view changes over time.)

### `_design/sessions` — sessions by time & location

Maps `type === "summary"`.

| View | Key | Value | Reduce |
|------|-----|-------|--------|
| `by_date` | `[year, month, day]` | `{ session_id, event_count, prompt_count, error_count, cwd }` | `_count` |
| `by_cwd` | `[cwd, timestamp]` | `{ session_id, event_count, prompt_count }` | `_count` |

`by_date` (descending) drives the webui session list.

### `_design/events` — events by session & type

Maps `type === "event"`.

| View | Key | Value | Reduce |
|------|-----|-------|--------|
| `by_session` | `[session_id, timestamp]` | `{ event, tool_name, input_preview }` | — |
| `by_type` | `[event, year, month, day]` | `1` | `_count` |

`by_session` reassembles a session's event timeline.

### `_design/tools` — tool usage & failures

| View | Key | Value | Reduce |
|------|-----|-------|--------|
| `usage` | `[tool_name, year, month, day]` | `1` | `_count` |
| `failures` | `[tool_name, timestamp]` | `{ session_id, error_preview, cwd }` | — |
| `errors` | `[tool_name?, timestamp]` | `{ session_id, error_preview, cwd }` | — |

`failures` maps `PostToolUseFailure`; `errors` is broader (any doc with an `error`
field), keyed `"unknown"` when no tool name.

### `_design/activity` — hourly timeline

| View | Key | Value | Reduce |
|------|-----|-------|--------|
| `timeline` | `[year, month, day, hour]` | `1` | `_count` |

### `_design/chunks` — content reassembly

| View | Key | Value | Reduce |
|------|-----|-------|--------|
| `by_session` | `[session_id, byte_start]` | `{ byte_start, byte_end, entry_count }` | — |
| `entry_count_by_session` | `session_id` | `entry_count` | `_sum` |

`by_session` reassembles a session's chunked content in byte order.

### `_design/session_meta` — running-session enrichment & token rollup

| View | Key | Value | Reduce |
|------|-----|-------|--------|
| `start_meta` | `session_id` | `{ timestamp, model, cwd, hostname }` | — |
| `tokens_by_date` | `[year, month, day]` | `{ input, output, cacheCreation, cacheRead, total, sessions }` | `_sum` |

`start_meta` (maps `SessionStart` events) lets the webapi enrich sessions that have
started but have no summary yet.

### Planned feature views

Deferred until validated against a running CouchDB ([mid-flight-chunking.md](mid-flight-chunking.md),
[actions.md](actions.md) → `extract-feature`): `features/urls`, then
repos / PRs / issues / `/`-commands / models, and the cross-session "events of
interest" views (single timeline, durations, active-vs-idle).

## Mango index

`indexes/type.json` defines `idx-type` on `{ fields: ["type"] }`, so filtering docs
by `type` doesn't scan the whole DB. Index creation is non-fatal — an optimisation,
not a correctness requirement.

## Keeping the mirrors in sync

When a view changes, edit **both** `hooks/couchdb/.../designs/*.json` and the
matching design in `ensure.ts` (the map function bodies must match). The hook's
`setup-views.sh` applies the former; the webapi applies the latter on every boot
(idempotent upsert carrying `_rev` forward). Schema/view evolution is captured as
versioned [migrations](migrations.md).

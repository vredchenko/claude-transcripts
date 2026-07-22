# CouchDB document types — catalogue

A single-page **catalogue of every CouchDB document type** the system uses or
plans to use: what it is, who writes it and when, and its key fields. This is the
index; the **deep schemas, the status model, and the design views** live in
[couchdb.md](couchdb.md), and schema evolution is governed by
[migrations.md](migrations.md). Storage rationale: CouchDB is the primary store
([ADR 0007](decisions/0007-couchdb-primary-store.md)); full transcript bytes never
live here, only in S3 ([ADR 0014](decisions/0014-transcripts-live-in-s3-only.md)).

## Invariants (all types)

- **Append-only.** Docs are added, effectively never edited in place — keeps the
  corpus replication-friendly.
- **Every doc carries `type` and an explicit `timestamp`** (CouchDB doesn't stamp
  wall-clock time).
- **Keyed by Claude Code's own `session_id`** (a UUID) wherever identity matters,
  so a session is addressable across machines.
- **Schemas are defined in code** (TS types + runtime validators, e.g. zod) and
  validated at the webapi on write ([ADR 0016](decisions/0016-webapi-is-the-io-gateway.md)).
- **Tolerant of foreign/legacy docs** — views coalesce missing fields to defaults.

## Databases

| Database | Holds | Notes |
|----------|-------|-------|
| `claude-sessions` (default) | Session corpus: `event`, `summary`, `chunk`, `session_start`, `meta`, `schema_version` | The primary store. |
| app-logs DB *(separate)* | `log` (operational/app logs) | Kept out of the corpus — see [app-logging.md](app-logging.md) / [ADR 0018](decisions/0018-app-logging-into-couchdb.md). |

## Catalogue

`Status`: **exists** = written today · **planned** = designed, not yet wired.
The **Owner to define** column is intentionally left for you to complete (final
field set, validation rules, retention).

| `type` | `_id` | DB | Written by → when | Status | Purpose | Owner to define |
|--------|-------|----|-------------------|--------|---------|-----------------|
| [`event`](#event) | auto (CouchDB-assigned) | `claude-sessions` | per-event handlers → live, per hook event | **exists** | One marker doc per hook event; the per-session activity stream. | which events emit a doc; exact per-event marker fields; preview length caps |
| [`summary`](#summary) | `summary:<sessionId>` | `claude-sessions` | session-end (live) / `backfill` → at session end | **exists** | The end-of-session rollup; a session is `ended` iff this exists. `source` is `"live"` (hook) or `"backfill"` (adopted transcript). | final rollup field set; `end_reason` vocabulary; `system_checks` shape |
| [`chunk`](#chunk) | `chunk:<sessionId>:<byte_start>` | `claude-sessions` | `backfill` (reconstructed) · chunk-flush (live) | **exists** | Append-only byte-faithful slice of the transcript ([mid-flight-chunking.md](mid-flight-chunking.md)). Both `backfill` and the live mid-flight chunker emit them via the shared `sliceIntoChunks`. With `couchFullContentChunks` on, each chunk also embeds its parsed `entries[]` (`schema_version` 2, [ADR 0027](decisions/0027-full-content-chunks-in-couchdb.md)) via `buildChunkEntries`. | prune policy; map-reduce views over `entries[]` (speaker-split, per-turn search) |
| [`session_start`](#session_start) | `session_start:<sessionId>` | `claude-sessions` | session-start → once, at start | **planned** | A first-class start record so a running session is queryable before any summary exists (feeds the `running` status + `start_meta` view). | does this replace/duplicate the `SessionStart` `event` doc? fields beyond start metadata |
| [`meta`](#meta) | auto | `claude-sessions` | enrichment endpoint → any time, append-only | **planned** | Out-of-band enrichment attached to a session (host/actor attribution, tags, derived/extracted facts) without mutating existing docs. | the enrichment vocabulary; whether feature extraction (urls/repos/PRs) is `meta` or its own type; who may write it |
| [`schema_version`](#schema_version) | `schema_version` | `claude-sessions` | migrations → on migrate | **planned** | Singleton recording the applied schema/migration version for the DB. | exact shape (single int vs per-type map); how it interacts with per-doc `schema_version` |
| [`log`](#log) | auto | app-logs DB *(separate)* | webapi/app → on log event | **planned** | Application/operational logs, kept out of the session corpus. | log schema; levels; retention; which subsystems emit |

> **Candidate future types** (not yet committed — flagged for your call): a
> dedicated **`feature`** type for extracted "events of interest" (URLs, repos,
> PRs, issues, `/`-commands, models) if those outgrow `meta`
> ([couchdb.md → planned feature views](couchdb.md#planned-feature-views),
> [actions.md](actions.md) → `extract-feature`); a **subagent sub-transcript**
> record if subagent runs need first-class capture beyond `event` markers
> ([tools.md](tools.md) → `backfill`). Decide whether each is a new `type` or a shape
> of `meta`.

---

## Per-type field sketches

Concise shape only — the authoritative, validated schemas live in
[couchdb.md](couchdb.md) and in the shared code types. Fields marked `?` are
optional; `TODO` marks something for the owner to finalise.

### `event`

Common fields on every event doc, plus event-specific marker fields.

```jsonc
{
  "type": "event",
  "event": "PostToolUse",          // the hook event name
  "session_id": "<cc uuid>",
  "timestamp": "2026-01-01T00:00:00.000Z",
  "hostname": "…",
  "cwd": "/abs/path"
  // + event-specific marker fields — see couchdb.md "Event-specific additions"
  //   and the full event list in hook-events.md
}
```

See [hook-events.md](hook-events.md) for every hook event and its input payload;
the marker fields we persist per event are a deliberately short subset (full
content lives in `chunk`/S3). **TODO (owner):** confirm which of the 30 events emit
an `event` doc and their exact marker fields.

### `summary`

```jsonc
{
  "_id": "summary:<sessionId>",
  "type": "summary",
  "event": "SessionEnd",
  "session_id": "<cc uuid>",
  "timestamp": "…", "hostname": "…", "cwd": "/abs/path",
  "end_reason": "user-input | session-limit | unknown",   // TODO: reconcile with CC SessionEnd `reason` vocabulary
  "event_count": 0, "prompt_count": 0, "error_count": 0,
  "tool_counts": { "Bash": 12, "Edit": 5 },
  "transcript_bytes": 0,                                   // size only; content in S3
  "token_usage": { "input": 0, "output": 0, "cacheCreation": 0, "cacheRead": 0, "total": 0, "messages": 0 },
  "system_checks": {},                                     // TODO: define
  "source": "live | backfill",                             // "live" = hook-recorded; "backfill" = adopted transcript
  "backfilled_at": "…"                                     // only on backfilled docs; the real session time stays in `timestamp`
}
```

### `chunk`

```jsonc
{
  "_id": "chunk:<sessionId>:<byte_start padded to 12>",
  "type": "chunk",
  "session_id": "<cc uuid>",
  "byte_start": 10240, "byte_end": 10752,
  "entry_count": 8,
  "timestamp": "…", "hostname": "…", "cwd": "/abs/path",
  "schema_version": 2,
  // Present only with couchFullContentChunks (schema_version 2); one entry per
  // non-blank line, partitioned 1:1 with the byte slice. See ADR 0027.
  "entries": [
    { "role": "user", "timestamp": "…", "text": "…" },
    { "role": "assistant", "timestamp": "…", "text": "…", "toolUses": [{ "name": "Edit", "id": "tu_1" }] },
    { "role": "tool_result", "toolUseId": "tu_1", "isError": false, "text": "…" }
  ]
}
```

### `session_start` *(planned)*

```jsonc
{
  "_id": "session_start:<sessionId>",
  "type": "session_start",
  "session_id": "<cc uuid>",
  "timestamp": "…", "hostname": "…", "cwd": "/abs/path",
  "source": "startup | resume | clear | compact",
  "model": "…",
  "permission_mode": "…"
  // TODO (owner): is this a distinct doc or just the SessionStart `event` doc?
}
```

### `meta` *(planned)*

```jsonc
{
  "type": "meta",
  "session_id": "<cc uuid>",
  "timestamp": "…",
  "meta_kind": "TODO",        // e.g. "attribution" | "tag" | "feature" | …
  "data": { /* TODO: per-kind payload */ }
}
```

### `schema_version` *(planned)*

```jsonc
{
  "_id": "schema_version",
  "type": "schema_version",
  "version": 1               // TODO: single int vs per-type map
}
```

### `log` *(planned, separate DB)*

```jsonc
{
  "type": "log",
  "timestamp": "…",
  "level": "info | warn | error",   // TODO
  "subsystem": "webapi | hook | …", // TODO
  "message": "…",
  "data": { /* TODO */ }
}
```

> Keep this catalogue in step with the code schemas and the design views in
> [couchdb.md](couchdb.md); a type or field change is a versioned
> [migration](migrations.md).

# CouchDB document types — catalogue

A single-page **catalogue of every CouchDB document type** the system uses or
plans to use: what it is, who writes it and when, and its key fields. This is the
index; the **deep schemas, the status model, and the design views** live in
[couchdb.md](couchdb.md), and schema evolution is governed by
[migrations.md](../operate/migrations.md). Storage rationale: CouchDB is the primary store
([ADR 0007](../design/decisions/0007-couchdb-primary-store.md)); the byte-faithful transcript
lives only in S3 ([ADR 0014](../design/decisions/0014-transcripts-live-in-s3-only.md)), and
CouchDB holds parsed, pruned turns on full-content chunks
([ADR 0027](../design/decisions/0027-full-content-chunks-in-couchdb.md)).

## Invariants (all types)

- **Append-only.** Docs are added, effectively never edited in place — keeps the
  corpus replication-friendly.
- **Every doc carries `type` and an explicit `timestamp`** (CouchDB doesn't stamp
  wall-clock time).
- **Keyed by Claude Code's own `session_id`** (a UUID) wherever identity matters,
  so a session is addressable across machines.
- **Schemas are defined in code** (zod validators in the webapi's `routes/ingest.ts`;
  the ingested docs are built in `packages/cli/src/lib/session-docs.ts`, the hook's
  inline in `packages/cli/src/hook/handlers.ts`) and validated at the webapi on write ([ADR 0016](../design/decisions/0016-webapi-is-the-io-gateway.md))
  — for documents that arrive *through* it. The hook writes to CouchDB directly, so its
  documents are not validated on write; the shapes below are what it is expected to
  produce, not what is enforced.
- **Tolerant of foreign/legacy docs** — views coalesce missing fields to defaults.

## Databases

| Database | Holds | Notes |
|----------|-------|-------|
| `claude-transcripts-sessions` (default) | Session corpus: `event`, `summary`, `chunk`, `session_start`, `meta`, `schema_version` | The primary store. |
| `claude-transcripts-app-logs` (default, *separate*) | `log` (operational/app logs) — **empty today**: created on boot, written by nothing yet | Kept out of the corpus — see [app-logging.md](../operate/app-logging.md) / [ADR 0018](../design/decisions/0018-app-logging-into-couchdb.md). |

## Catalogue

`Status`: **exists** = written today · **planned** = designed, not yet wired.
The **Owner to define** column is intentionally left for you to complete (final
field set, validation rules, retention).

| `type` | `_id` | DB | Written by → when | Status | Purpose | Owner to define |
|--------|-------|----|-------------------|--------|---------|-----------------|
| [`event`](#event) | auto (CouchDB-assigned) | `claude-transcripts-sessions` | per-event handlers → live, per hook event | **exists** | One marker doc per hook event; the per-session activity stream. | which events emit a doc; exact per-event marker fields; preview length caps |
| [`summary`](#summary) | `summary:<sessionId>` | `claude-transcripts-sessions` | session-end (live) / `backfill` → at session end | **exists** | The end-of-session rollup; a session is `ended` iff this exists. `source` is `"live"` (hook), `"backfill"` (adopted transcript) or `"doctor"` (smoke-test session). | final rollup field set; `end_reason` vocabulary; `system_checks` shape |
| [`chunk`](#chunk) | `chunk:<sessionId>:<byte_start>` | `claude-transcripts-sessions` | `backfill` (reconstructed) · `flush-transcript-chunk` (live) | **exists** | Append-only byte-faithful slice of the transcript ([mid-flight-chunking.md](../design/mid-flight-chunking.md)). Both `backfill` and the live mid-flight chunker emit them via the shared `sliceIntoChunks`. With `couchFullContentChunks` on, each chunk also embeds its parsed `entries[]` (`schema_version` 2, [ADR 0027](../design/decisions/0027-full-content-chunks-in-couchdb.md)) via `buildChunkEntries`. | prune policy |
| [`session_start`](#session_start) | `session_start:<sessionId>` | `claude-transcripts-sessions` | session-start → once, at start | **planned** | A first-class start record so a running session is queryable before any summary exists (feeds the `running` status + `start_meta` view). | does this replace/duplicate the `SessionStart` `event` doc? fields beyond start metadata |
| [`meta`](#meta) | auto | `claude-transcripts-sessions` | enrichment endpoint → any time, append-only | **planned** | Out-of-band enrichment attached to a session (host/actor attribution, tags, derived/extracted facts) without mutating existing docs. | the enrichment vocabulary; whether feature extraction (urls/repos/PRs) is `meta` or its own type; who may write it |
| [`schema_version`](#schema_version) | `schema_version` | `claude-transcripts-sessions` | migrations → on migrate | **exists** | Singleton recording the applied migration version plus the `applied[]` history. Written after **each** step, so an interrupted run stays consistent ([migrations.md](../operate/migrations.md)). | — |
| [`log`](#log-planned-separate-db) | auto | app-logs DB *(separate)* | nothing yet (the `app-log` action is unbound) | **planned** | Application/operational logs, kept out of the session corpus. | log schema; levels; retention; which subsystems emit |

> **Candidate future types** (not yet committed — flagged for your call): a
> dedicated **`feature`** type for extracted "events of interest" (URLs, repos,
> PRs, issues, `/`-commands, models) if those outgrow `meta`
> ([couchdb.md → planned feature views](couchdb.md#planned-feature-views),
> [actions.md](actions.md) → `extract-feature`); a **subagent sub-transcript**
> record if subagent runs need first-class capture beyond `event` markers
> ([tools.md](../operate/tools.md) → `backfill`). Decide whether each is a new `type` or a shape
> of `meta`.

---

## Per-type field sketches

Concise shape only — the authoritative, validated schemas live in
[couchdb.md](couchdb.md) and in code (above). Fields marked `?` are
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

Full shape: [couchdb.md → `summary`](couchdb.md#summary).

### `chunk`

Full shape: [couchdb.md → `chunk`](couchdb.md#chunk).

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

### `schema_version`

Written by the [migration runner](../operate/migrations.md) after **each** step, so an
interrupted run still leaves a consistent marker.

```jsonc
{
  "_id": "schema_version",
  "type": "schema_version",
  "version": 9,              // highest migration id applied; 0 = pristine
  "applied": [               // ordered history: appended on up, popped on down
    { "id": 1, "name": "initial-schema", "at": "2026-06-20T09:14:02.881Z" }
  ]
}
```

### `log` *(planned, separate DB)*

Nothing writes this type yet. Its proposed shape — `type`, `timestamp`, `level`,
`component`, optional `session_id`, `message`, `context` — is kept in one place:
[app-logging.md → Record shape](../operate/app-logging.md#record-shape-proposed).

> Keep this catalogue in step with the code schemas and the design views in
> [couchdb.md](couchdb.md); a type or field change is a versioned
> [migration](../operate/migrations.md).

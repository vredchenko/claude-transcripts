# Design discussion — agent-first session corpus (working notes)

> **Status: raw working notes captured from the 2026-06-17 design session.** Not the
> final spec — owner will refine these into the formal docs and refresh issue #15.
> Preserved here so the discussion isn't lost when we move dev off the live clone.
> Builds on issue #15 (architecture redesign) and #4 (logging rework / chunking,
> already partly implemented on this branch). See also `docs/mid-flight-chunking.md`.

## North star (unchanged from #15)

The primary consumer is **Claude Code itself**: a structured, searchable, replicated
corpus of past sessions for recall + self-retrospective, beyond log rotation and
across machines. Human browse/search is secondary.

## Layered architecture — graceful degradation is a first principle

Nothing optional may break the core. Losing host-side ingestion, Meilisearch, or the
fs transcript must degrade features, not the system.

- **Core tier (must always work; hook → CouchDB only):**
  - a **session-start doc** (written once, never edited) with the hook/transcript-native
    standard metadata;
  - a **per-event marker doc** for every supported CC hook event;
  - **chunk docs** carrying the session content.
  - All append-only, timestamped, referencing the session by Claude's own session id.
- **Enrichment tier (optional, best-effort):**
  - a **schemaless metadata endpoint** on the webapi (`POST .../sessions/{id}/meta`)
    that *anything* can post to — at session start and post-factum. Each post is a
    **new append-only doc** referencing `session_id` (never edits the start doc).
  - a **standard host-side collector** we define + ship, that posts the config/prompt/
    manifest metadata the hook can't see.
  - an optional **transcript-parser CLI** for `backfill` + verification.
  - Meilisearch as a per-node derived index.

## Document model

- **Single CouchDB database, append-only**, almost never overwrite. Every doc has a
  `type`, a `timestamp`, and (except the session-start doc) a `session_id`.
- Doc types: `session_start` (rich, once), `event` (one per hook event occurrence),
  `chunk` (content slices), `summary` (at end), enrichment/`meta` docs (schemaless).
- Map-reduce design views aggregate by `session_id` to reassemble a full transcript,
  and across sessions for cross-session queries.
- Use **Claude Code's own session id**, never a generated one.

## Chunking

- **Always on — no feature flag.** Only the **buffer/flush** behaviour is configurable
  (`logging.chunk.maxEntriesPerChunk`, `flushIntervalMs`).
- **Structural, not raw-byte:** chunk on **whole JSONL entries** (one line = one JSON
  object = a message or tool result). The byte offset is only a **crash-safe resume
  bookmark**, not a content boundary.
- A logical **chat message** can span multiple entries (streaming chunk + snapshot
  duplicates) → reassemble messages at **view/read time** by message id (same dedup
  rule as token accounting). Chunks stay byte-faithful to their slice = append-only,
  replication-safe.
- The transcript is a **DAG**, not a list: every entry has `uuid` + `parentUuid`;
  edits/forks create branches. We store full parsed entries, so `uuid`/`parentUuid`
  are retained — branch-aware thread reconstruction is a reader concern. Timestamp
  order drives the timeline; `parentUuid` drives logical threading.
- Flushing already forces on `Stop` (turn boundary), so chunks tend to align to turns.
- **Open choice:** chunk id = `seq` + `ts` field (leaning) vs the current `byte_start`.

## Timestamps — first-class on every doc

- CouchDB does **not** stamp docs with wall-clock time (only `_rev` generation +
  `_changes` seq for ordering). So **we write an explicit `ts` on every doc.**
- The box running Claude == the box running the hook, so the hook `ts` and Claude's
  **per-entry transcript timestamps** share one clock — internally consistent.
- Capture per-entry transcript timestamps inside chunks (enables durations + idle/active).
- **Clock-skew guard:** if the webapi (possibly a different host/container) stamps a
  receipt time on the enrichment endpoint, label it separately (`received_ts`); the
  host `ts` is canonical for ordering.
- Goals these enable: cross-session **single timeline**, **action durations** (tool
  use / web search), **active-vs-idle** time for long-running sessions.
- **Open choice (durations):** wire `PreToolUse` for explicit tool-span start markers,
  or derive purely from transcript entry timestamps (may suffice now that we capture them).

## Standard metadata — what's actually available (from research)

The `SessionStart` hook payload is lean: `session_id`, `transcript_path`, `cwd`,
`source`, `model` (+ `hook_event_name`). It does **not** include the system prompt,
the skills/plugins/MCP/tools/settings manifest, the CLI version, the OS username, or
permission_mode. So the standard set splits by source:

| Field | Source | Tier |
|---|---|---|
| session_id, cwd, model, source, hostname, ts | hook payload / in-process | 0 (hook-native) |
| token usage + per-turn/per-tool breakdown | transcript (`message.usage`); extends `sumTranscriptTokens` | 0 |
| **CLI version** | transcript entry `version` field (NOT a payload field / subprocess) | 0 (derivable) |
| gitBranch, cwd-over-time | transcript entries | 0 (bonus) |
| OS username | `whoami` / `$USER` | 1 (host-side) |
| full prompt *ingredients*, skills/plugins/MCP/tools/settings manifest | disk config + `InstructionsLoaded` paths | 1 (collector) |
| anything else | user's own tooling | 2 (schemaless) |

- The **standard set is defined by us** (drives views/webui) even where it's Tier-1
  (our collector populates it); user-supplied extras are Tier-2 schemaless. Missing
  fields coalesce to "unknown" in views (#7 backward-compat pattern).
- **Honest caveat:** even the collector can capture only the prompt *ingredients*
  (loaded instruction files + merged settings + tool list), not the literal assembled
  system-prompt string the model saw — that string is exposed nowhere.
- `InstructionsLoaded` (a real, observe-only event) fires with each loaded
  `CLAUDE.md`/`.claude/rules/*.md` **path + load_reason** (not contents) — the
  hook-native breadcrumb for "what context this session started with."

## Events & events-of-interest

- **Register all ~30 supported CC hook events**, each occurrence → its own light
  marker doc (`type:"event"`, `event:<name>`, `session_id`, `ts`, minimal payload),
  duplicates included. Observe-only — we never block.
- High-value additions beyond the current 8: `PreToolUse` (tool start → durations),
  `InstructionsLoaded`, `PreCompact`/`PostCompact`, `Notification`,
  `PermissionRequest`/`PermissionDenied`, `UserPromptExpansion`, task/teammate events.
- **Events of interest** (within + across sessions) are then **map-reduce over the
  marker docs + chunks**, more accurate than regex over raw text. Examples:
  - every user text message → `UserPromptSubmit`;
  - messages > 255 chars → `prompt_length`;
  - ESC interrupt → `is_interrupt` on `PostToolUseFailure`;
  - dialogue runs (≥2 sequential exchanges) → sequence analysis over the event stream.

## Memory-save detection

No native memory hook exists. Memory writes are **tool calls** → detect via
`PostToolUse` matching `Edit|Write` on `…/memory/` paths (and `CLAUDE.md`/`AGENTS.md`).
`tool_input.file_path` is in the payload to filter on. (Owner wants a deeper look.)

## fs transcript parser (research conclusion)

- **Build our own thin, standalone, optional CLI**, extending `sumTranscriptTokens`.
  Absent tool/transcript must never block core logging.
- No existing tool fits a vendor-neutral TS/Bun project: `ccusage` (Rust+CLI, the
  token-accounting gold standard), `claude-code-log` (Python), a typed Rust crate,
  and the official `@anthropic-ai/claude-agent-sdk` — which **spawns the full CLI as a
  subprocess (~900 MB/call)**, violating the repo's zero-host-assumptions charter.
- Crib the entry **schema** (not a runtime dep) from the Rust crate; validate our token
  math against `ccusage` output in tests as a correctness oracle.
- Two uses: **backfill** un-logged sessions, and **verify** a logged session by diffing
  CouchDB content against the fs transcript (a free smoke test).
- Transcript format: location is documented (`~/.claude/projects/<proj>/<id>.jsonl`),
  per-field schema is reverse-engineered. Key fields: `type`, `uuid`, `parentUuid`,
  `timestamp`, `sessionId`, `cwd`, `gitBranch`, `version`; `message.usage.*`; content
  blocks (`text`/`thinking`/`tool_use`/`tool_result`). Mind branching when deduping
  tokens (known `file-history-snapshot` messageId/uuid collision bug).

## Deltas from the branch as it stands

1. Drop the `midFlightChunking` + `couchFullContentChunks` flags → always chunk, always
   store pruned content; keep only `logging.chunk.*`.
2. Formalize a dedicated **`session_start` doc type** with the standard metadata block
   (drop the false `permission_mode` dependency — not in payload).
3. Capture **per-entry transcript timestamps** + `version`/`gitBranch` in chunks.
4. **Wire all supported hook events** as marker docs + add events-of-interest views.
5. Add the **schemaless metadata endpoint** (webapi) + the **standard host-side
   collector** + the **standalone parser CLI** — all graceful-degradation extras.
6. Cross-session **views**: single timeline, durations, active-vs-idle, events-of-interest.

## Open decisions
- Chunk id: `seq` + `ts` vs `byte_start`.
- Durations: `PreToolUse` markers vs transcript-entry timestamps only.
- Memory detection depth (path-match now; revisit if Claude adds a native hook).
- Exact standard-metadata field list (owner to provide) + which are Tier-1 collector.

## Cross-refs
#15 (redesign / Phase 2 replication), #4 (chunking — this branch), #3 (config/prompt
enrichment), #5 (hooks inventory), #6 (`backfill` + verify), #7 (actor/machine
metadata), #9 (Meilisearch), #11 (secrets/pruning).

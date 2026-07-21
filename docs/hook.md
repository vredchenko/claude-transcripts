# hook — codebase reference

The **write side**: a Claude Code plugin (Bun/TypeScript) that logs every session
to CouchDB + S3 as it happens. It installs separately from the app (it runs on
each machine where you use Claude Code) and is a **pure observer** — every
handler is observe-only and every external call is wrapped so the hook can never
block or fail a session.

For installation steps see [hook-setup.md](hook-setup.md); for the full list of
Claude Code events and which we wire, see [hooks.md](hooks.md).

- **Directory:** `hooks/` (ships as a standalone plugin —
  [ADR 0004](decisions/0004-bun-monorepo-hook-as-standalone-plugin.md))
- **Entry point:** `scripts/dispatch.ts`, registered for all eight events.

## File layout

```
hooks/
├── .claude-plugin/plugin.json   # plugin manifest
├── hooks/hooks.json             # event → dispatch.ts registration
├── couchdb/claude-sessions/
│   ├── designs/*.json           # design docs (sessions, events, tools, activity, chunks, session_meta)
│   └── indexes/type.json        # Mango index on `type`
└── scripts/
    ├── dispatch.ts              # single entry point; routes events → handlers
    ├── handlers/                # one module per event (+ chunk-flush)
    ├── lib/                     # config, context, couch, blob, counts, chunk-* , prune
    ├── setup.sh                 # generate runtime config + ensure DB/views
    ├── setup-views.sh           # sync design docs + indexes (idempotent)
    ├── smoke-test.ts            # end-to-end write-path check
    └── transcript-tokens.ts     # sumTranscriptTokens (byte-identical to shared)
```

## Dispatch & routing (`scripts/dispatch.ts`)

`hooks/hooks.json` registers the **eight** session-activity events, each running
`bun run ${CLAUDE_PLUGIN_ROOT}/scripts/dispatch.ts` (`SessionStart`/`SessionEnd`
get a 180 s timeout; the high-frequency events 5 s, async). The dispatcher:

1. Parses the hook payload from stdin.
2. Builds a context (`lib/context.ts` → config + couch/blob/counts helpers).
3. Exits silently if there's no config or no event/`session_id`.
4. Looks the event up in a `REGISTRY` (one event → one or more handlers) and runs
   them with `Promise.allSettled` — a handler throwing never blocks the session.

`REGISTRY`:

| Event | Handlers |
|-------|----------|
| `SessionStart` | `session-start` |
| `UserPromptSubmit` | `user-prompt-submit`, `chunk-flush` |
| `PostToolUse` | `post-tool-use`, `chunk-flush` |
| `PostToolUseFailure` | `post-tool-use-failure`, `chunk-flush` |
| `Stop` | `stop`, `chunk-flush` |
| `SubagentStart` | `subagent-start` |
| `SubagentStop` | `subagent-stop` |
| `SessionEnd` | `session-end` |

## Handlers (`scripts/handlers/`)

Every event handler writes a CouchDB **event doc** stamped with the common fields
`{ type: "event", event, session_id, timestamp, hostname, cwd }` plus event
specifics, and bumps the per-session counters in `/tmp`:

| Handler | Event | Adds to the doc | Counters |
|---------|-------|-----------------|----------|
| `session-start` | `SessionStart` | `source`, `model`, `permission_mode`; resets counters; seeds chunk offset | events |
| `user-prompt-submit` | `UserPromptSubmit` | `prompt_length`, `prompt_preview` (200 chars) | events, prompts |
| `post-tool-use` | `PostToolUse` | `tool_name`, `tool_use_id`, `input_preview` | events, tools[name] |
| `post-tool-use-failure` | `PostToolUseFailure` | `tool_name`, `error_preview`, `is_interrupt` | events, errors |
| `stop` | `Stop` | `stop_hook_active` | events |
| `subagent-start` | `SubagentStart` | `agent_id`, `agent_type` | events |
| `subagent-stop` | `SubagentStop` | `agent_id`, `agent_type` | events |

**`session-end`** (`SessionEnd`) is the exception — it writes the **summary doc**,
not an event doc, then uploads to S3:

1. Final forced chunk flush (when chunking is on) + clear `/tmp` chunk state.
2. Read & clear the `/tmp` counters; read the transcript; compute `token_usage`
   via `sumTranscriptTokens`.
3. `PUT summary:<sessionId>` (`type: "summary"`, `source: "live"` — vs `"backfill"`
   for a summary adopted by the CLI's `backfill`) with `end_reason`, `event_count`,
   `prompt_count`, `error_count`, `tool_counts`, `transcript_bytes`, `token_usage`,
   `system_checks`.
4. Upload `<sessionId>/summary.json` and `<sessionId>/transcript.jsonl` to S3 —
   the transcript's **only** durable home
   ([ADR 0014](decisions/0014-transcripts-live-in-s3-only.md)).

## Library (`scripts/lib/`)

| Module | Role |
|--------|------|
| `config.ts` | Loads the runtime config (`CT_CONFIG` or `~/.config/claude-transcripts/config.json`); returns `null` (→ silent skip) if absent. Non-secret settings are baked from `claude-transcripts.config.json`. |
| `context.ts` | `buildCtx(input)` — extracts payload fields, opens couch/blob/counts, and exposes `commonFields()`. |
| `couch.ts` | `makeCouch(config)` — `postDoc` / `putDoc` over HTTP basic auth, 4 s timeout, failures swallowed. |
| `blob.ts` | `makeBlob(config)` — `Bun.S3Client` `put`; `enabled` only when an access key is set; bucket creation is out-of-band. |
| `counts.ts` | `/tmp/claude-transcripts-<id>.counts` per-session counter store (`events`/`prompts`/`errors`/`tools`). |
| `transcript-chunks.ts` | `flushChunks(ctx, path, force)` — mid-flight tailing + chunk-doc writes. |
| `chunk-state.ts` | Offset/flush-time state + `O_EXCL` lockfile in `/tmp` (30 s stale break). |
| `prune.ts` | `pruneEntry` — placeholder pruning (truncate huge strings, drop base64 images) before chunk storage; S3 keeps the un-pruned master. |

## Mid-flight chunking

Behind the `features.midFlightChunking` flag (off by default), the `chunk-flush`
handler tails the live `transcript.jsonl` and writes append-only
`chunk:<sessionId>:<byte_start>` docs to CouchDB during the session — crash
resilience plus content that map-reduce views can see. It flushes on a size/time
batch policy (`logging.chunk.maxEntriesPerChunk` / `flushIntervalMs`, forced on
`Stop`/`SessionEnd`), advances a byte offset over whole `\n`-terminated lines, and
guards the read→write→advance section with a lockfile. The full design (offsets,
locking, resumes, the `couchFullContentChunks` content flag, pruning) is in
[mid-flight-chunking.md](mid-flight-chunking.md) and issue #4.

## Operational scripts

- **`setup.sh`** — generates `~/.config/claude-transcripts/config.json`
  (mode 600) by merging `.env` secrets with the non-secret block from
  `claude-transcripts.config.json`, creates the CouchDB database, and calls `setup-views.sh`.
  Re-run with `FORCE=1` to regenerate. (The S3 bucket must already exist.)
- **`setup-views.sh`** — idempotently PUTs every `couchdb/.../designs/*.json`
  (carrying `_rev` forward) and POSTs the Mango indexes.
- **`smoke-test.ts`** — seeds a synthetic session through the full write path
  (CouchDB docs, S3 round-trip, view queries) and prints PASS/FAIL; `--keep`
  leaves it for the UI.
- **`transcript-tokens.ts`** — the hook's copy of `sumTranscriptTokens`, kept
  **byte-identical** with `packages/shared/src/index.ts` (change both).

## Plugin manifest (`.claude-plugin/plugin.json`)

`name: claude-transcripts`, `version: 0.1.0`, describing the logger and
its CouchDB + S3 (Garage) targets. Installing the `hooks/` directory as a plugin is
what makes `${CLAUDE_PLUGIN_ROOT}` resolve in `hooks.json`.

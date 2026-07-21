# Hook setup

The hook (`hook/`) is the writer half of the project: a Claude Code plugin that
logs every session's events, an end-of-session summary, and the full transcript
to CouchDB + an S3-compatible blob store (Garage). The webapi/webui then read
that data back.

## Prerequisites

- [Bun](https://bun.sh) on the machine running Claude Code (the hook scripts are
  Bun TypeScript).
- A reachable CouchDB and an S3 bucket — either the bundled `deploy/` stack or
  your own. The bucket must already exist (the hook does not create it).

## 1. Configure

Fill a `.env` (copy the repo-root `.env.example`) with your CouchDB credentials
and S3 (Garage) key, then generate the hook config:

```bash
cd hook
ENV_FILE=../.env bash scripts/setup.sh
```

This writes `~/.config/claude-transcripts/config.json` (mode 600),
creates the CouchDB database, and syncs the design docs + Mango index. Re-run
with `FORCE=1` to regenerate the config.

The config shape (the `db`/`bucket` names + `features`/`logging` blocks are baked
in from the repo-root `claude-transcripts.config.json` — see [`configuration.md`](configuration.md)):

```json
{
  "couch": { "url": "http://127.0.0.1:5984", "db": "claude-sessions", "auth": "user:pass" },
  "blob": {
    "endpoint": "http://127.0.0.1:3900",
    "region": "garage",
    "accessKey": "...",
    "secretKey": "...",
    "bucket": "claude-sessions"
  },
  "features": { "s3Blobs": true },
  "logging": { "chunk": { "maxEntriesPerChunk": 200, "flushIntervalMs": 15000 } }
}
```

Omit `blob` (or leave `accessKey` empty) to log event/summary docs to CouchDB
only. Note S3 is the transcript's sole home (ADR 0014): without a `blob` backend,
transcript content is not persisted anywhere — only the summary doc's
`transcript_bytes` is recorded.

## 2. Verify

```bash
bun run scripts/smoke-test.ts
```

Seeds one synthetic session through the whole write path (CouchDB doc, S3 blob
round-trip, view queries) and prints PASS/FAIL. It cleans up after itself;
pass `--keep` to leave the seeded session for the UI.

## 3. Register the hook with Claude Code

Point Claude Code at `hooks/hooks/hooks.json`. The simplest route is to install
the directory as a plugin (so `${CLAUDE_PLUGIN_ROOT}` resolves):

```bash
claude plugin install /absolute/path/to/claude-transcripts/hook
```

Or reference the hook commands directly in your `~/.claude/settings.json`,
substituting the absolute path to `hooks/scripts/dispatch.ts`.

### Architecture

`hooks/hooks.json` registers the eight session-activity hook events, each
pointing at the single entry point `scripts/dispatch.ts`. The dispatcher reads
the hook payload, builds a context (config + CouchDB/S3/counts helpers from
`scripts/lib/`), and fans out to the handler modules in `scripts/handlers/` —
one event can drive many handlers. The registered events (each with a handler):

`SessionStart`, `UserPromptSubmit`, `PostToolUse`, `PostToolUseFailure`, `Stop`,
`SubagentStart`, `SubagentStop`, `SessionEnd`. Live events POST as they happen;
`SessionEnd` writes the summary + transcript.

This is the same focused set a predecessor logging hook used; it avoids the
per-event Bun startup cost of the high-frequency events. Wiring any other
supported event (`PreToolUse`, `Notification`, `PreCompact`, `MessageDisplay`, …)
is future scope: add a module in `scripts/handlers/`, name it in the `REGISTRY`
in `dispatch.ts`, and register the event in `hooks.json`.

## 4. (Optional) Backfill existing history

Adopting on-disk history is no longer a hook script — it's the CLI's `backfill`
command ([cli.md](cli.md), [tools.md](tools.md)), which reconstructs each session
at parity with a live recording (summary + per-event docs, and — planned — chunk
docs) rather than a thin summary-only record:

```bash
claude-transcripts backfill --dry-run   # preview
claude-transcripts backfill             # adopt ~/.claude/projects/**.jsonl
```

Backfilled summaries are tagged `source: "backfill"` (+ `backfilled_at`) to distinguish
them from live (`source: "live"`) recordings, and the transcript's real timestamps
are preserved. Existing sessions are skipped, so it's safe to re-run.

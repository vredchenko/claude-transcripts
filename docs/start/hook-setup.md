# Hook setup

The hook (`hooks/`) is the writer half of the project: a Claude Code plugin that
logs every session's events, an end-of-session summary, and the full transcript
to CouchDB + an S3-compatible blob store (Garage). The webapi/webui then read
that data back.

## Prerequisites

- [Bun](https://bun.sh) on the machine running Claude Code (the hook scripts are
  Bun TypeScript).
- A reachable CouchDB and an S3 bucket — either the bundled `deploy/` stack or
  your own. The bucket must already exist (the hook does not create it).

## 1. Configure

`claude-transcripts install` does all of this for you — it generates the instance's
secrets and ports, starts the backing services, provisions the stores, and writes the
hook config. Reach for the steps below only when wiring the hook against stores you
already run.

From a source checkout, fill a `.env` (copy `.env.template`) with your CouchDB
credentials and S3 (Garage) key, then write the hook's runtime config:

```bash
bun run cli setup            # verify later with: bun run cli setup --check
```

That writes `~/.config/claude-transcripts/config.json` (mode 600) and ensures the
CouchDB databases exist. The store names and the `features`/`system` blocks are
projected from [`config/config.json`](configuration.md) (falling back to the committed
`config.template.json`); the URLs and credentials come from `.env`:

```json
{
  "couch": {
    "url": "http://127.0.0.1:7652",
    "databases": {
      "sessions": "claude-transcripts-sessions",
      "appLogs": "claude-transcripts-app-logs"
    },
    "auth": "user:pass"
  },
  "blob": {
    "endpoint": "http://127.0.0.1:7653",
    "region": "garage",
    "accessKey": "...",
    "secretKey": "...",
    "buckets": { "sessions": "claude-transcripts-sessions" }
  },
  "features": { "s3Blobs": true, "midFlightChunking": true, "couchFullContentChunks": true },
  "system": { "logging": { "chunk": { "maxEntriesPerChunk": 200, "flushIntervalMs": 15000 } } }
}
```

`databases` and `buckets` are **keyed maps**, not single names — the system is
designed for more than one of each, and consumers address them by logical key
(`sessions`, `appLogs`) rather than by the deployed name.

Add a `mirrors` array to write every session to a second instance as well as this
one — see [mirrors.md](../operate/mirrors.md). It is the one key a rewrite preserves,
since nothing else on the machine records it.

Omit `blob` (or leave `accessKey` empty) to log event/summary docs to CouchDB
only. Note S3 is the transcript's sole home (ADR 0014): without a `blob` backend,
transcript content is not persisted anywhere — only the summary doc's
`transcript_bytes` is recorded.

## 2. Verify

```bash
claude-transcripts doctor
```

Drives one synthetic session through the whole path — CouchDB doc, S3 blob
round-trip, view queries, search — and prints what passed. It cleans up after
itself.

## 3. Register the hook with Claude Code

The normal route needs neither a plugin nor a checkout — the installed binary
registers itself:

```bash
claude-transcripts hook install
```

It merges into `~/.claude/settings.json`, so other tools' hooks are untouched and
re-running is a no-op. `claude-transcripts hook status` shows what's registered.

If you'd rather use Claude Code's plugin mechanism, install the `hooks/` directory
(so `${CLAUDE_PLUGIN_ROOT}` resolves):

```bash
claude plugin install /absolute/path/to/claude-transcripts/hooks
```

That form still requires the CLI to be installed: the plugin is a shim that pipes each
payload to `claude-transcripts hook run`.

### Architecture

Either route ends in the same place — `claude-transcripts hook run`
([hook.md](../reference/hook.md)) — which reads one payload on stdin and runs the
**actions** bound to that event by the app model. One event can drive several actions;
they run concurrently and settled, and the process always exits 0.

Registered events (11, in lifecycle order): `SessionStart`, `UserPromptSubmit`,
`PostToolUse`, `PostToolUseFailure`, `SubagentStart`, `SubagentStop`, `PreCompact`,
`PostCompact`, `Stop`, `StopFailure`, `SessionEnd` — the full catalogue, including
which events are deliberately *not* bound and why, is generated into
[hook-events.md](../reference/hook-events.md). Live
events write as they happen; `SessionEnd` writes the summary + transcript.

To wire another supported event (`PreToolUse`, `Notification`, `PreCompact`, …), add
the binding to the model's `BINDINGS` and re-run `bun run gen:hooks` — dispatch and
registration are both projections of it, so neither is edited by hand.

## 4. (Optional) Backfill existing history

Adopting on-disk history is no longer a hook script — it's the CLI's `backfill`
command ([cli.md](../reference/cli.md), [tools.md](../operate/tools.md)), which reconstructs each session
at parity with a live recording (summary + per-event docs, and — planned — chunk
docs) rather than a thin summary-only record:

```bash
claude-transcripts backfill --dry-run   # preview
claude-transcripts backfill             # adopt ~/.claude/projects/**.jsonl
```

Backfilled summaries are tagged `source: "backfill"` (+ `backfilled_at`) to distinguish
them from live (`source: "live"`) recordings, and the transcript's real timestamps
are preserved. Existing sessions are skipped, so it's safe to re-run.

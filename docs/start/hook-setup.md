# Hook setup

`claude-transcripts install` configures and registers the hook for you. This page is
for wiring the hook by hand: against stores you already run, from a checkout, or on a
machine that records to an instance elsewhere.

## 1. Write the runtime config

The hook reads one file, `~/.config/claude-transcripts/config.json` (mode 600,
`CT_HOOK_CONFIG` overrides the path). From a checkout, fill `.env` with your CouchDB
credentials and S3 key, then:

```bash
bun run cli setup --no-hook   # write the config, create the CouchDB databases, probe the bucket
bun run cli setup --check     # verify later, read-only
```

Store names, `features`, `system` and `recall` come from
[`config/`](configuration.md); URLs and credentials from `.env`:

```jsonc
{
  "couch": {
    "url": "http://127.0.0.1:7652",
    "databases": { "sessions": "claude-transcripts-sessions", "appLogs": "claude-transcripts-app-logs" },
    "auth": "user:pass"
  },
  "blob": {
    "endpoint": "http://127.0.0.1:7653",
    "region": "garage",
    "accessKey": "…",
    "secretKey": "…",
    "buckets": { "sessions": "claude-transcripts-sessions" }
  },
  "webapi": { "url": "http://127.0.0.1:7650" },   // used by the CLI, ignored by the hook
  "features": { … },
  "system": { … },
  "recall": { … }
}
```

- The bucket must already exist; the hook never creates it.
- Without `blob` (or with an empty `accessKey`), only CouchDB docs are written and no
  byte-exact transcript is kept ([ADR 0014](../design/decisions/0014-transcripts-live-in-s3-only.md)).
- `webapi.url` is written only when `CT_WEBAPI_URL` or `WEBAPI_PORT` is set. On a
  machine that records to a remote deployment, set it by hand.
- Add `mirrors` to also write every session to a second instance
  ([mirrors.md](../operate/mirrors.md)).
- A rewrite by `setup` or `install` keeps `mirrors` and `webapi`; everything else is
  regenerated.
- No config means the hook does nothing, silently.

## 2. Register the hook

```bash
claude-transcripts hook install     # merge into ~/.claude/settings.json
claude-transcripts hook status      # what is registered, where, and any mirrors
```

Re-running is a no-op, other tools' hooks are untouched, and an older registration is
updated in place. From a checkout, `bun run cli setup` (without `--no-hook`) registers
`bun run <clone>/packages/cli/src/cli.tsx hook run` instead. Use `--no-hook` on a
development machine that already records through an installed binary, or it gets a
second logger.

Per-project registration (`setup --project`) is not built; registration is global.

The plugin is the alternative route
([installation.md](installation.md#registering-the-hook-binary-or-plugin)). From a
checkout it can be installed by path:

```bash
claude plugin install /absolute/path/to/claude-transcripts/hooks
```

Use one route, not both: with both, every event is recorded twice.

## 3. Verify

```bash
claude-transcripts doctor
```

Drives one synthetic session through CouchDB, S3, the views and search, reports what
passed, and deletes it again (`--keep` leaves it for inspection).

## 4. Adopt existing history (optional)

```bash
claude-transcripts backfill --dry-run   # preview
claude-transcripts backfill             # adopt ~/.claude/projects/**/*.jsonl
```

Backfilled sessions are tagged `source: "backfill"` and keep the transcript's real
timestamps. Sessions already present are skipped, so it is safe to re-run. Details in
[tools.md](../operate/tools.md).

## How the hook works

Every route ends at `claude-transcripts hook run` ([hook.md](../reference/hook.md)): it
reads one payload on stdin, runs the actions the blueprint binds to that event
concurrently, and always exits 0. Eleven events are registered: `SessionStart`,
`UserPromptSubmit`, `PostToolUse`, `PostToolUseFailure`, `SubagentStart`,
`SubagentStop`, `PreCompact`, `PostCompact`, `Stop`, `StopFailure`, `SessionEnd`.
[hook-events.md](../reference/hook-events.md) lists every Claude Code event and why the
others are not bound.

# Hook setup

`claude-transcripts install` configures and registers the hook for you. This page is
for wiring the hook by hand: against an instance you already run, from a checkout, or on
a machine that records to an instance elsewhere.

The hook writes only through a webapi's `/api/ingest/*` routes
([ADR 0016, amendment 2](../design/decisions/0016-webapi-is-the-io-gateway.md#amendment-2-the-hook-writes-through-the-webapi)),
so wiring it means naming one URL. It needs no store address and no store credential.

## 1. Write the runtime config

The hook reads one file, `~/.config/claude-transcripts/config.json` (mode 600,
`CT_HOOK_CONFIG` overrides the path). Write it, and check the instance takes writes:

```bash
claude-transcripts setup --no-hook --webapi http://127.0.0.1:7650   # or the remote instance's URL
claude-transcripts setup --check                                     # verify later, read-only
```

Without `--webapi`, the URL comes from `CT_WEBAPI_URL`, else `WEBAPI_HOST`/`WEBAPI_PORT`,
else the URL already in the file, else `http://127.0.0.1:7650`. `features`, `system`
and `recall` come from [`config/`](configuration.md):

```jsonc
{
  "webapi": { "url": "http://127.0.0.1:7650" },   // required: where the hook writes
  "features": { … },
  "system": { … },
  "recall": { … }
}
```

- `webapi` may also take `auth` (`user:password`) and `timeoutMs` / `blobTimeoutMs`,
  as a mirror does.
- Add `mirrors` to also write every session to more instances
  ([mirrors.md](../operate/mirrors.md)).
- A rewrite by `setup` or `install` keeps `mirrors` and `webapi`; everything else is
  regenerated. A `couch` or `blob` block left by an older release is dropped, along with
  its credentials.
- No config, or one without `webapi.url`, means the hook records nothing, and the
  session-start banner and statusline say so.

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

Drives one synthetic session through the webapi's ingest routes into CouchDB and S3,
reads it back through the views and search, reports what passed, and deletes it again
(`--keep` leaves it for inspection). It also checks that the hook's configured target
takes writes.

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
concurrently, and always exits 0. Fourteen events are registered: `SessionStart`,
`UserPromptSubmit`, `PostToolUse`, `PostToolUseFailure`, `SubagentStart`,
`SubagentStop`, `PostModelSwitch`, `CwdChanged`, `DirectoryAdded`, `PreCompact`,
`PostCompact`, `Stop`, `StopFailure`, `SessionEnd`.
[hook-events.md](../reference/hook-events.md) lists every Claude Code event and why the
others are not bound.

---
name: transcripts-admin
description: Operate and troubleshoot the Claude Transcripts instance — when the statusline shows "ct off"/"ct stalled", the session-start banner says not recording, search returns nothing, history is missing, or the user asks to back up, restore, migrate, reindex, upgrade or uninstall it. Maps each symptom to the `claude-transcripts` command that fixes it.
---

# transcripts-admin — operate and troubleshoot

The instance is: a Claude Code hook (the `claude-transcripts` binary) writing to
CouchDB + S3 (Garage), a webapi reading it back, optionally Meilisearch for search, a
webui. All of it is driven by one CLI. **Run diagnostics before changing anything**,
and prefer the command that reports over the one that rewrites.

## From symptom to command

| You see | It means | Do |
|---|---|---|
| Banner: *not recording (no instance configured)* / statusline `○ ct off · no instance configured` | No hook runtime config on this machine | `claude-transcripts install` (full setup) — or `setup` if the stores already exist elsewhere |
| Statusline `○ ct off · not recording this session` with an instance configured | The hook isn't firing for this session: not registered, or registered after the session started | `claude-transcripts hook status`; if not registered, `hook install`, then **restart Claude Code** (hook config is snapshotted at session start) |
| Statusline `◌ ct ready · no write yet` for more than a minute | Hook runs but CouchDB hasn't accepted a write | `claude-transcripts doctor`; `stack ps` / `stack up`; check the CouchDB URL in the hook config (`hook status` prints its path) |
| Statusline `◐ ct stalled` | Writes were landing and have stopped | `claude-transcripts stack ps` → `stack up` or `stack restart couchdb`; then `doctor` |
| `/claude-transcripts:status` says the CLI isn't on PATH | The plugin is installed but the binary isn't | Install the CLI: the release binaries, or `bunx @claude-transcripts/cli install` |
| `search` says *not enabled* | `features.meilisearch` is off | Turn it on in the instance config, `stack up`, `reindex` |
| `search` finds nothing it should | Index behind or empty | `claude-transcripts reindex` (safe: rebuilds derived state from CouchDB) |
| Old sessions from before install are missing | They were never recorded | `claude-transcripts backfill --dry-run`, then `backfill` — adopts `~/.claude/projects` transcripts |
| A session has no transcript / turns | Logged before full-content chunks, or never reached SessionEnd | `sessions <id> --json` shows `hasTranscript`/`source`; `backfill --force --session <id>` re-adopts from disk if it's still there |
| Statusline not showing at all | Not registered, or another statusLine is set | `claude-transcripts statusline status`; `statusline install` — it will **not** overwrite someone else's statusLine; it prints how to compose them |
| After upgrading the CLI | Hook/statusline registrations may point at the old path | `hook install` and `statusline install` are idempotent — re-run them; `migrate status` for schema changes |

## Routine operations

- **Health**: `claude-transcripts doctor` — writes one synthetic session through the
  real path, reads it back, checks search, deletes it. Exit 0 = healthy.
- **Back up**: `claude-transcripts export <dir>` (add `--since <iso>` for
  incremental, `--no-blobs` for docs only). **Restore**: `import <dir> --dry-run`,
  then `import <dir>`.
- **Move to another machine**: `export` there → `install` here → `import`.
- **Schema**: `migrate status` / `migrate up --dry-run` / `migrate up`.
- **Containers**: `stack ps | up | down | restart | logs <service>`. `stack down
  --volumes` **deletes the data** — confirm with the user first.
- **Remove**: `uninstall` keeps history; `uninstall --purge` deletes it — confirm first.

## Rules

- Never run a destructive command (`--purge`, `stack down --volumes`, `import` over a
  populated instance, `backfill --force` without `--session`) without the user's
  explicit go-ahead in this conversation.
- The hook must never block a session; if it seems to, the fix is `hook uninstall`
  first, diagnose second.
- Every command accepts `--webapi <url>`; if the bare command reports a dead webapi
  on an unexpected port, that's usually the fix.
- Config lives in the instance's `app.json` and the hook's `config.json` (paths from
  `hook status`); after editing, re-run `setup` so the hook config is rebaked.

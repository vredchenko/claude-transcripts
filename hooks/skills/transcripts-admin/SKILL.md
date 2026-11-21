---
name: transcripts-admin
description: Operate and troubleshoot the Claude Transcripts instance — when the statusline shows "ct off"/"ct stalled", the session-start banner says not recording, search returns nothing, history is missing, or the user asks to back up, restore, migrate, reindex, upgrade or uninstall it. Maps each symptom to the `claude-transcripts` command that fixes it.
---

# transcripts-admin — operate and troubleshoot

The instance is: a Claude Code hook (the `claude-transcripts` binary) writing through a
webapi into CouchDB + S3 (Garage), the same webapi reading it back, optionally Meilisearch for search, a
webui. All of it is driven by one CLI. **Run diagnostics before changing anything**,
and prefer the command that reports over the one that rewrites.

## From symptom to command

| You see | It means | Do |
|---|---|---|
| Banner: *NOT recording — `<host>`: unreachable / HTTP … / stores unavailable* | The hook is configured, but its webapi can't take writes right now | `claude-transcripts hook status` (names the target and the reason); for a local instance `stack ps` → `stack up`; then `backfill` to recover what was missed |
| Banner: *not recording — … names stores but no webapi* | A config from before the hook wrote through the webapi | `claude-transcripts setup` (or `setup --webapi <url>`) rewrites it; restart Claude Code |
| Banner: *not recording — no instance configured* / statusline `○ ct@<version> off · no instance configured` | No hook runtime config on this machine | `claude-transcripts install` (full setup) — or `setup --webapi <url>` to record into an instance hosted elsewhere |
| Statusline `○ ct@<version> off · not recording this session` with an instance configured | The hook isn't firing for this session: not registered, or registered after the session started | `claude-transcripts hook status`; if not registered, `hook install`, then **restart Claude Code** (hook config is snapshotted at session start) |
| Statusline `◌ ct@<version> ready · … · no write yet` for more than a minute | Hook runs but nothing has been written yet | `claude-transcripts hook status` (is the webapi it writes to reachable?); `doctor` |
| Statusline `◐ ct@<version> stalled · hook silent` | The session keeps going but the hook stopped being invoked (no write *or* failure for 5+ minutes while the transcript moved) | `claude-transcripts hook status` — registration removed or the binary it points at gone/broken; `hook install`, then **restart Claude Code** |
| Statusline `◐ ct@<version> stalled · <reason> · … · run claude-transcripts backfill` | The webapi rejected or didn't answer the last write (`HTTP 503`, `timeout`, `unreachable`) | `claude-transcripts hook status`; for a local instance `stack ps` → `stack up` / `stack restart`, `stack logs app` to see why; once writes land again, `claude-transcripts backfill` recovers the gap from the on-disk transcript |
| Statusline `● ct@<version> rec (mirror) · … · run claude-transcripts backfill` | A mirror is recording, the instance isn't | Same as above for the instance; `backfill` fills its gap |
| `hook status`, `doctor` or `setup --check`: *mirror … same as webapi.url* / *is the webapi itself* | A `mirrors` entry names this machine's own instance, typically left over from a pre-0.11 config. The hook already ignores it | `claude-transcripts setup` drops it, or delete the entry from `mirrors` in the hook config |
| Statusline shows a version behind the instance's | That machine records from a checkout or a stale binary, and everything is lockstep-versioned ([ADR 0023](../../../docs/design/decisions/0023-lockstep-versioning-and-combined-image.md)) | `claude-transcripts install` to upgrade it; compare against the app's version at `GET /api/blueprint` |
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
- **Containers**: `stack ps | up | down | restart | logs [service…]` — only `logs` takes
  service names. `stack down
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

# CLI

> **Status: built and released.** `@claude-transcripts/cli` ships as a compiled
> binary per platform on each release, and as the CLI bundled into the app image. It
> **is** the hook (`hook run`), the installer (`install`), and the admin surface
> (`backfill`, `export`/`import`, `migrate`, `reindex`, `doctor`, `sessions`,
> `search`). The scripts it consolidated are gone; `scripts/` now holds dev-only repo
> automation ([dev-automation.md](../develop/dev-automation.md)).

A terminal client for the system, and the **admin utility** for setup and data
operations. It is an **optional interface** — the system is fully usable without
it (and without the webui) — but it's the most convenient surface for humans at a
terminal and for **AI agents driving the system headless**.

## Two roles

1. **Application client** (talks to the webapi). Everything the webui can do, the
   CLI can do, because both are just webapi consumers
   ([ADR 0016](../design/decisions/0016-webapi-is-the-io-gateway.md)): list/inspect sessions,
   read transcripts, query views via `/api/couch`, fetch blobs via `/api/s3`,
   run searches, post enrichment metadata. **All app-side reads and writes go
   through the webapi** — the CLI never touches CouchDB/S3 directly.
2. **Admin / host-side utility** (talks to the host). The operations that are
   inherently local: `smoke-test`, `install`/`setup` (register the hook, generate
   runtime config), `configure`, `export`/`import` (bundle round-trip), and
   `backfill` (adopt on-disk `~/.claude` transcripts as first-class history). Host-side
   **metadata ingestion** (reading local config/transcripts the container can't
   see) is the one legitimately non-webapi path — it's an input source, delivered
   *to* the webapi, not a backend write around it.

## Architecture — an aggregate of internal modules

The CLI is a **single tool assembled from multiple internal sources** — the same
way Claude Code itself is built. Each capability is its own TS module/package,
imported as an internal library; the CLI is the aggregate front end that exposes
them under one command surface:

| Internal module | Responsibility | Source |
|-----------------|----------------|--------|
| **webapi client** | All app-side reads/writes | **generated** from the webapi OpenAPI spec ([ADR 0019](../design/decisions/0019-openapi-source-of-truth-generated-clients.md)) and imported as a lib — never hand-written |
| **`.claude/` reader/parser** | Read + parse the local `~/.claude/` filesystem (transcripts, projects, config) for `backfill` and verification | its own module/package within the CLI |
| **hooks setup** | Install/register the Claude Code hooks, generate runtime config | host-side |
| **export / import** | User-data bundle round-trip (dump/restore), format conversion | shares the [migrations](../operate/migrations.md) machinery |
| **admin** | `setup` / `configure` / `smoke-test` | host-side |

New functionality is added as **another internal module + a command**, so the tool
grows by composition. The `.claude/` reader is deliberately a standalone module
(like the generated client) so it can be reused/tested in isolation and never
blocks core CLI use if absent.

## Stack

- **Bun + [Ink](https://github.com/vadimdemedes/ink)** — the same runtime + TUI
  stack Claude Code itself is built with, so the CLI feels native alongside it and
  we can follow Claude Code's own Bun/TS/CLI build practices.
- **Generated API client** (above) — the same source of truth the webui uses.
- Reads the same backend config as the rest of the repo for host-side operations
  (`COUCHDB_*`, `S3_*`); for app-side operations it only needs the webapi base URL.
- **Finding the webapi** (`src/api/http.ts`) — `--webapi`, else `CT_WEBAPI_URL`, else
  `WEBAPI_PORT`, else the **installed instance's** `instance.env`, else `7650`.
  `install` allocates a port per instance, so without the `instance.env` step the bare
  commands would report a dead webapi on a port nothing was listening on. Only the
  *port* pins the target; `WEBAPI_HOST` just chooses the host for it — `.env.template`
  ships a `WEBAPI_HOST` and Bun loads it for anything run from a checkout, so letting
  it count as a named target would suppress the lookup. The webui's dev proxy resolves
  the same way ([webui.md](webui.md#build--dev-viteconfigts)). Resolution happens on
  **first use and is then memoised** — importing the module stays inert, so a fault in
  the resolver can't take down every command at load, and `--webapi` skips the instance
  read entirely.

## Packaging (deferred)

To make the host-side CLI portable to machines without a Bun runtime, we intend to
ship **compiled single-file binaries** per OS (Bun supports `bun build
--compile`). The exact packaging/release flow is **deferred** — for now it runs
under Bun. In the combined container the CLI is **bundled in the image**, and the
webui offers a **download link** for it as a convenience
([containers.md](../operate/containers.md), [routes.md](routes.md)).

## Command surface

The authoritative list is the app model's `CLI_SPEC` (`packages/shared/src/model/cli.ts`).
Four things project from it: the help screen (`claude-transcripts <command> --help`),
argument validation before dispatch, this reference (generated below by
`bun run gen:cli-docs`; CI fails if it is stale), and — not built yet — shell
completions. Edit the spec, not this section.

### Exit codes

| Exit | Means |
|---|---|
| `0` | success; also `--help` / `--version` |
| `1` | the command ran and failed (the message says why) |
| `2` | usage error — unknown command, unknown option, bad value; help/usage goes to **stderr** |

`--help`, `--version` and the usage errors are handled *before* a command runs, which
is why `backfill --help` shows help rather than running a backfill, and why a script
can tell a typo from a failure.

<!-- gen:cli-docs:start — generated from CLI_SPEC by `bun run gen:cli-docs`; do not edit -->
**Lifecycle**

| Command | What it does |
|---|---|
| `install [options]` | Set up everything: stores, app, and the Claude Code hook |
| `uninstall [options]` | Remove the instance (history is kept unless --purge) |
| `setup [options]` | Install/register the hook + generate runtime config |
| `provision` | Create the CouchDB databases and the Garage bucket + key |
| `stack [action] [options]` | Control the container stack |

**Daily use**

| Command | What it does |
|---|---|
| `sessions [id] [options]` | List / inspect sessions (via the webapi) |
| `search <query> [options]` | Search the corpus |
| `backfill [options]` | Adopt on-disk ~/.claude transcripts as first-class history |

**Portability**

| Command | What it does |
|---|---|
| `export <dir> [options]` | Export session data to a portable bundle |
| `import <dir> [options]` | Restore session data from a portable bundle |

**Admin**

| Command | What it does |
|---|---|
| `migrate [direction] [options]` | Run CouchDB migrations |
| `reindex` | Rebuild the search indexes from CouchDB |
| `doctor [options]` | Smoke-test the write/read/search path end-to-end |
| `hook [action] [options]` | The Claude Code hook, and its registration |
| `statusline [action] [options]` | The Claude Code statusline indicator (recording / off), and its registration |

**Global options** (every command)

- `--webapi <value>` — webapi base URL (default: $CT_WEBAPI_URL)
- `--help` — show help for a command (alias: -h)
- `--version` — print the CLI version (alias: -V)

### `install [options]`

Set up everything: stores, app, and the Claude Code hook

| Option | |
|---|---|
| `--port-base <n>` | first port of the block (default 7650) |
| `--meili-key` | generate a Meilisearch master key |
| `--no-hook` | skip Claude Code registration |
| `--no-statusline` | register the hook but not the statusline |
| `--no-app` | skip the app container (run the webapi yourself) |
| `--no-prune` | keep superseded app images |
| `--skip-preflight` | continue past failed preflight checks |
| `--yes` | no prompts; take documented defaults |

```bash
claude-transcripts install
claude-transcripts install --port-base 7700 --no-hook
```

### `uninstall [options]`

Remove the instance (history is kept unless --purge)

| Option | |
|---|---|
| `--purge` | also delete recorded history (destructive) |
| `--yes` | skip the confirmation prompt |

```bash
claude-transcripts uninstall
claude-transcripts uninstall --purge --yes
```

### `setup [options]`

Install/register the hook + generate runtime config

| Option | |
|---|---|
| `--check` | verify an existing install (read-only) |
| `--no-hook` | config + provision stores only (no registration) |
| `--project` | per-repo registration (placeholder — not built) |

```bash
claude-transcripts setup --check
```

### `provision`

Create the CouchDB databases and the Garage bucket + key

```bash
claude-transcripts provision
```

### `stack [action] [options]`

Control the container stack

| Argument | |
|---|---|
| `action` | `logs` takes service names after it (up \| down \| restart \| logs \| ps; default ps) |

| Option | |
|---|---|
| `--app` | include the app container |
| `--volumes` | with `down`: delete the data volumes too |

```bash
claude-transcripts stack up --app
claude-transcripts stack logs couchdb
claude-transcripts stack down --volumes
```

### `sessions [id] [options]`

List / inspect sessions (via the webapi)

| Argument | |
|---|---|
| `id` | session id — show detail/transcript (omit to list) |

| Option | |
|---|---|
| `--limit <n>` | rows to list (default 50) / transcript entries to preview (default 30) |
| `--json` | print the webapi response as JSON instead of a table |

```bash
claude-transcripts sessions
claude-transcripts sessions --limit 10
claude-transcripts sessions 3f9a2c1e --limit 80 --json
```

### `search <query> [options]`

Search the corpus

| Argument | |
|---|---|
| `query` | required. search text |

| Option | |
|---|---|
| `--limit <n>` | results per section (default: the webapi's) |
| `--offset <n>` | skip this many results (paging) |
| `--cwd <value>` | only this project directory |
| `--model <value>` | only this model |
| `--hostname <value>` | only this host |
| `--source <value>` | only this provenance (live \| backfill \| …) |
| `--json` | print the webapi response as JSON instead of a table |

```bash
claude-transcripts search "retry policy"
claude-transcripts search deploy --cwd ~/proj --limit 5 --json
```

### `backfill [options]`

Adopt on-disk ~/.claude transcripts as first-class history

| Option | |
|---|---|
| `--dir <value>` | transcripts dir (default ~/.claude/projects) |
| `--host <value>` | hostname to attribute (default: this host) |
| `--actor <value>` | actor to attribute the history to |
| `--chunk-size <n>` | entries per chunk doc (default 200) |
| `--no-content` | byte-range chunks only (no turn content) |
| `--force` | re-process sessions already adopted |
| `--session <value>` | with --force: re-process only this session |
| `--dry-run` | preview without writing |

```bash
claude-transcripts backfill --dry-run
claude-transcripts backfill
claude-transcripts backfill --force --session 3f9a2c1e
```

### `export <dir> [options]`

Export session data to a portable bundle

| Argument | |
|---|---|
| `dir` | required. destination directory |

| Option | |
|---|---|
| `--since <value>` | only docs at/after this ISO timestamp |
| `--session <value>` | only this session id |
| `--no-blobs` | skip S3 transcripts (~1/10th the size) |

```bash
claude-transcripts export ./bundle
claude-transcripts export ./bundle --since 2026-01-01 --no-blobs
```

### `import <dir> [options]`

Restore session data from a portable bundle

| Argument | |
|---|---|
| `dir` | required. bundle directory |

| Option | |
|---|---|
| `--dry-run` | verify the bundle without writing |
| `--no-blobs` | skip transcripts; restore docs only |

```bash
claude-transcripts import ./bundle --dry-run
claude-transcripts import ./bundle
```

### `migrate [direction] [options]`

Run CouchDB migrations

| Argument | |
|---|---|
| `direction` | apply, roll back, or report (up \| down \| status; default status) |

| Option | |
|---|---|
| `--to <n>` | with `up`: stop at this schema version |
| `--steps <n>` | with `down`: how many to undo (default 1) |
| `--dry-run` | report what would run without writing |

```bash
claude-transcripts migrate status
claude-transcripts migrate up --dry-run
claude-transcripts migrate down --steps 2
```

### `reindex`

Rebuild the search indexes from CouchDB

```bash
claude-transcripts reindex
```

### `doctor [options]`

Smoke-test the write/read/search path end-to-end

| Option | |
|---|---|
| `--keep` | leave the synthetic session behind for inspection |

```bash
claude-transcripts doctor
claude-transcripts doctor --keep
```

### `hook [action] [options]`

The Claude Code hook, and its registration

| Argument | |
|---|---|
| `action` | `run` reads one event payload from stdin (Claude Code calls this) (run \| install \| uninstall \| status; default status) |

| Option | |
|---|---|
| `--dry-run` | with `install`: show the change without writing |

```bash
claude-transcripts hook status
claude-transcripts hook install --dry-run
```

### `statusline [action] [options]`

The Claude Code statusline indicator (recording / off), and its registration

| Argument | |
|---|---|
| `action` | `render` reads Claude Code's statusline JSON from stdin and prints one line (no network) (render \| install \| uninstall \| status; default status) |

| Option | |
|---|---|
| `--dry-run` | with `install`: show the change without writing |

```bash
claude-transcripts statusline install
claude-transcripts statusline status
```
<!-- gen:cli-docs:end -->

Not built, and listed here only so the gap is visible: `couch` / `s3` power-user
passthroughs, and `meta post` enrichment.

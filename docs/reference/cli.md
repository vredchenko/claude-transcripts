# CLI

`claude-transcripts` is the installer, the hook (`hook run`), the admin tool and a
terminal client. Release binaries for Linux and macOS (x64, arm64) embed the Bun
runtime; the app image bundles one at `/cli/download`; from a checkout run
`bun run cli <command>`.

- **Client commands** (`sessions`, `search`, `turns`, `export`, `import`, `migrate`,
  `reindex`, `doctor`, `backfill`) go through the webapi, using a client generated from
  its OpenAPI spec ([ADR 0019](../design/decisions/0019-openapi-source-of-truth-generated-clients.md)).
  `sessions`, `search` and `turns` take `--json` for scripts and agents.
- **Host commands** (`install`, `uninstall`, `setup`, `provision`, `stack`, `hook`,
  `statusline`) work on the local machine: containers, store provisioning, Claude
  Code's settings. `hook run` writes to CouchDB and S3 directly
  ([ADR 0016](../design/decisions/0016-webapi-is-the-io-gateway.md#amendment-the-hook-is-a-second-writer)).

**Which webapi:** `--webapi`, else `CT_WEBAPI_URL`, else `WEBAPI_PORT` (on
`WEBAPI_HOST`, default `127.0.0.1`), else `webapi.url` in the hook runtime config, else
the installed instance's port from `instance.env`, else `127.0.0.1:7650`.
`WEBAPI_HOST` alone does not count as choosing a target, because `.env.template` sets
it.

**Exit codes:** `0` success (also `--help`, `--version`); `1` the command ran and
failed; `2` usage error (unknown command or option, bad value), with usage on stderr.
Help, version and usage errors are handled before a command runs, so
`backfill --help` never starts a backfill.

**Shell completions:** `completions <shell>` prints a script for bash, zsh or fish.
Nothing edits an rc file for you, `install` included:

```bash
eval "$(claude-transcripts completions bash)"   # ~/.bashrc
eval "$(claude-transcripts completions zsh)"    # ~/.zshrc, after compinit
claude-transcripts completions fish | source    # ~/.config/fish/config.fish
```

It completes command names, flags (plus the global ones), and the values of anything
the spec lists `choices` for (`stack <action>`, `turns --role`). The command must be
the first word, and bash completes flag values in the `--flag value` form only.

The command reference below is generated from `CLI_SPEC`
(`packages/shared/src/model/cli.ts`) by `bun run gen:cli-docs`; edit the spec, not
this page. The same spec drives `--help`, argument validation and the completions.
Not built: `couch` / `s3` passthroughs and `meta post` enrichment.

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
| `turns [session] [options]` | Speaker-split turns: one session, or one speaker across all sessions |
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
| `completions <shell>` | Print a shell completion script to eval or source from your shell's rc |

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
| `--cwd <value>` | only this project directory |
| `--model <value>` | only this model |
| `--hostname <value>` | only this host |
| `--source <value>` | only this provenance (live \| backfill \| …) |
| `--from <value>` | only sessions overlapping at/after this ISO instant |
| `--to <value>` | only sessions overlapping at/before this ISO instant |
| `--json` | print the webapi response as JSON instead of a table |

```bash
claude-transcripts sessions
claude-transcripts sessions --limit 10
claude-transcripts sessions --cwd ~/dev/api --from 2026-08-01
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

### `turns [session] [options]`

Speaker-split turns: one session, or one speaker across all sessions

| Argument | |
|---|---|
| `session` | session id — that session's turns (omit: all sessions) |

| Option | |
|---|---|
| `--role <value>` | only this speaker (user \| assistant \| tool_result \| system \| other) |
| `--from <value>` | all sessions: only turns at/after this ISO instant |
| `--to <value>` | all sessions: only turns at/before this ISO instant |
| `--limit <n>` | turns to show (default 50) |
| `--skip <n>` | skip this many (paging) |
| `--json` | print the webapi response as JSON instead of a table |

```bash
claude-transcripts turns --role user --limit 200
claude-transcripts turns --role user --from 2026-08-01 --json
claude-transcripts turns 3f9a2c1e --role assistant
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
| `--force` | re-process adopted sessions (deletes their derived docs, then rebuilds) |
| `--replace-live` | with --force: also replace live-recorded sessions (loses hook provenance) |
| `--repair` | add what an interrupted write left out of an adopted session: missing chunk docs, or a transcript that never reached S3; leaves summary + events alone |
| `--session <value>` | with --force: re-process only this session |
| `--dry-run` | preview without writing (reads the store, so skips are shown) |

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
| `--force` | with `install`: register even if the plugin already does |

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

### `completions <shell>`

Print a shell completion script to eval or source from your shell's rc

| Argument | |
|---|---|
| `shell` | required. the shell to complete for (bash \| zsh \| fish) |

```bash
claude-transcripts completions bash
claude-transcripts completions fish | source
```
<!-- gen:cli-docs:end -->

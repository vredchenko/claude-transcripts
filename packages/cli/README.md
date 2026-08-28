# @claude-transcripts/cli

**Self-hosted history for your [Claude Code](https://claude.com/claude-code)
sessions** — the command-line interface.

[Claude Transcripts](https://github.com/vredchenko/claude-transcripts) records every
Claude Code session — events, an end-of-session summary (counts, tool usage, token
usage), and the full transcript — to **your own** CouchDB + S3-compatible storage. A
web API serves it back; a web UI, this CLI, and AI agents read it. Everything runs on
your own infrastructure and nothing leaves your network.

This CLI sets the whole system up, controls it, and reads the history back.

> ### ⚠️ Early — a preview, not something to depend on
>
> Breaking changes land without notice, and stored data may still have to be discarded
> between revisions. There is **no auth and no security model** — it assumes a single
> user on a single trusted machine, so don't expose it to a network or point it at
> anything you can't afford to lose. Issues and feedback are welcome.

## Requires Bun

This package is a [Bun](https://bun.sh)-runnable bundle and **needs `bun` on your
`PATH` at runtime** — it uses Bun's file, hashing, and subprocess APIs. It does not run
on Node.

| | |
|---|---|
| `bunx @claude-transcripts/cli` | ✅ |
| `bun add -g @claude-transcripts/cli` | ✅ |
| `npx` / `npm i -g` | ⚠️ works only if Bun is already installed |
| Node | ❌ |

**If you don't have Bun, don't use this package** — use the standalone binaries below
instead. They embed their own runtime and need nothing installed.

## Install

### The easy way — no Bun, no clone

One command. It fetches the release binary for your platform, verifies its checksum,
and hands over to `claude-transcripts install`, which generates this instance's secrets
and ports, starts the backing services, provisions the stores, starts the app, sets up
search, and registers the hook with Claude Code:

```bash
curl -fsSL https://raw.githubusercontent.com/vredchenko/claude-transcripts/main/install.sh | sh
```

Needs **Docker** and **Claude Code**. Standalone binaries for Linux and macOS (x64 and
arm64), with SHA-256 sums, are attached to
[every release](https://github.com/vredchenko/claude-transcripts/releases/latest) if
you'd rather fetch one yourself.

### With Bun

```bash
bunx @claude-transcripts/cli install     # one-off
bun add -g @claude-transcripts/cli       # or install it globally
```

## Quick start

```bash
claude-transcripts install     # set up stores, app, and the Claude Code hook
claude-transcripts doctor      # smoke-test write → read → search, end to end
claude-transcripts sessions    # what's been recorded
```

The web UI is at `http://127.0.0.1:<WEBAPI_PORT>/app` — `install` prints the address,
and picks a free port block per instance rather than assuming one. Re-running `install`
upgrades in place: it's idempotent and keeps your history.

## Commands

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
<!-- gen:cli-docs:end -->

`claude-transcripts <command> --help` shows a command's arguments, options and examples.
Full reference:
[docs/reference/cli.md](https://github.com/vredchenko/claude-transcripts/blob/main/docs/reference/cli.md).

## This is a CLI, not a library

The package exposes a `bin` and nothing else — there's no `main`, no `exports`, and no
type declarations, so it can't be imported. That's deliberate: the supported
programmatic interface is the **web API**, whose OpenAPI spec is the contract clients
are generated from. See
[docs/reference/webapi.md](https://github.com/vredchenko/claude-transcripts/blob/main/docs/reference/webapi.md).

## Links

- **Project site** — https://vredchenko.github.io/claude-transcripts/
- **Source** — https://github.com/vredchenko/claude-transcripts
- **Installation guide** —
  [docs/start/installation.md](https://github.com/vredchenko/claude-transcripts/blob/main/docs/start/installation.md)
- **Changelog** —
  [CHANGELOG.md](https://github.com/vredchenko/claude-transcripts/blob/main/CHANGELOG.md)
- **Issues** — https://github.com/vredchenko/claude-transcripts/issues

Every component is lockstep-versioned: one `vMAJOR.MINOR.PATCH` release versions the
hook, web API, web UI, and CLI as a set — so this package's version is also the version
of the instance it expects to talk to.

## License

MIT © vredchenko

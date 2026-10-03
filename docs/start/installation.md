# Installation

> **Not tested as ready for use.** No install has been walked end to end on a clean
> machine. Expect rough edges and treat stored data as disposable.

## Quick install

Needs **Docker** (with Compose v2) and **Claude Code**. Nothing else, not even Bun.

```sh
curl -fsSL https://raw.githubusercontent.com/vredchenko/claude-transcripts/main/install.sh | sh
```

`install.sh` fetches the release binary for your platform (Linux or macOS, x64 or
arm64), verifies its checksum, puts it in `~/.local/bin` and runs
`claude-transcripts install`. `CT_VERSION=vX.Y.Z` pins a release, `CT_BIN_DIR` changes
the target directory, `CT_NO_RUN=1` installs the binary only.

With the binary already on your `PATH`:

```sh
claude-transcripts install      # idempotent, safe to re-run
claude-transcripts doctor       # write a synthetic session, read it back, search it
```

Restart any open Claude Code sessions afterwards: Claude Code reads hook configuration
when a session starts, so sessions already running are not recorded.

Flags (`--port-base N`, `--meili-key`, `--no-hook`, `--no-statusline`, `--no-app`,
`--no-prune`, `--yes`, ...) are listed in [cli.md](../reference/cli.md#install-options).

## What `install` does

Each phase is idempotent and is also its own command, so a failure says which command
resumes from there:

1. **Preflight** — platform, Docker daemon reachable and usable by you, Compose v2,
   free ports, Claude Code's settings dir. All failures are reported at once; nothing
   is written until they pass. A busy port block is not a failure: install shifts to
   the next free block and says so.
2. **Configuration** — generates `instance.env`: CouchDB admin password, Garage
   secrets, the port block, and a Meilisearch master key only with `--meili-key`.
3. **Backing services** — `docker compose up` with public upstream images
   (`claude-transcripts stack up`), waiting on each service's health check.
4. **Provisioning** — CouchDB databases and migrations, Garage layout, bucket and app
   key (`claude-transcripts provision`). The S3 key is written back to
   `instance.env`, which is why the app starts after this.
5. **Application** — the combined app image, pinned to the CLI's own version (or
   `:main` for a non-release CLI). Waits for `/health` to answer (liveness only; it
   doesn't check the body's store status), warns on a version mismatch, then removes app images this upgrade superseded (never the one it just replaced;
   `--no-prune` opts out).
6. **Claude Code hook** — writes the hook runtime config and merges the hook (and the
   statusline, unless `--no-statusline`) into `~/.claude/settings.json`
   (`claude-transcripts hook install`). Other tools' entries are left alone.
7. **Search** — creates and fills the Meilisearch indexes.
8. **Verify** — prints the `doctor` command to run (with `--webapi` for this
   instance's port) and the UI and API URLs. It does not run `doctor` itself.

### Where things live

```
~/.local/bin/claude-transcripts            the binary, and the hook command
~/.config/claude-transcripts/
    config.json                            hook runtime config (0600)
    instance.env                           generated secrets + ports (0600)
    app.json                               app config, seeded once, yours to edit
~/.local/share/claude-transcripts/
    deploy/                                compose files written out of the binary
    deploy/data/                           CouchDB, Garage and Meilisearch data
    version                                version the assets belong to
~/.claude/settings.json                    hook + statusline registration
```

`CT_HOME=<dir>` relocates all of it (including the Claude settings file), which is
useful for a sandboxed trial.

### Behaviour worth knowing

- **One instance per machine.** Container names and the data dir are not namespaced.
  A contributor's dev stack (`bun run stack:up`) collides with an install; take one
  down before starting the other.
- **`--port-base` only applies to a new instance.** An existing `instance.env` is
  back-filled, never regenerated. To move ports, edit `instance.env` with the stack
  down, or uninstall first.
- **Stack down later** — the hook never blocks a session; events are dropped, and
  `backfill` can adopt the session afterwards from `~/.claude`.

## Upgrading

There is no `upgrade` command yet. Replace the binary:

```sh
P=linux-x64                # or linux-arm64, darwin-x64, darwin-arm64
B=https://github.com/vredchenko/claude-transcripts/releases/latest/download
curl -fLO "$B/claude-transcripts-$P"
curl -fLO "$B/claude-transcripts-$P.sha256"
sha256sum -c "claude-transcripts-$P.sha256"
install -m 755 "claude-transcripts-$P" ~/.local/bin/claude-transcripts
claude-transcripts --version
```

Swap `latest/download` for `download/vX.Y.Z` to pin a release. Re-running
`install.sh` does the same and picks the platform for you.

Then re-run `claude-transcripts install` to move the app image to the new version: the
binary and the app container are versioned together, and a schema mismatch makes
ingest reject documents without saying so. Do **not** run `install` on a
**client-only** machine (the hook writes to stores hosted elsewhere, no local
containers): it would stand up a stack the machine was never meant to have.

## Uninstalling

```sh
claude-transcripts uninstall            # deregister the hook, stop the stack
claude-transcripts uninstall --purge    # also delete recorded history (asks first)
```

`uninstall` is meant to keep history unless `--purge` is given. Take an
[`export`](../operate/migrations.md#export-and-import) first if the history matters.

## Registering the hook: binary or plugin

`install` registers the hook itself. The repo is also a Claude Code plugin marketplace,
a second route to the same writer:

```
/plugin marketplace add vredchenko/claude-transcripts
/plugin install claude-transcripts@claude-transcripts
```

The plugin contains no writer: it is a Bun shim (so this route needs **Bun** on
`PATH`) that pipes each payload to `claude-transcripts hook run`, so the CLI must
still be installed. It adds the skills, `/claude-transcripts:status` and the subagent
statusline ([plugin.md](../design/plugin.md)).

**Pick one route.** Both register the same eleven events, so with both active every
event is recorded twice. `hook install` and `setup` detect an enabled plugin and
decline to register alongside it; `claude-transcripts hook status` shows which route a
machine is on. Neither route auto-updates.

## From source

For a custom topology, or to see what `install` does by hand. Needs
[Bun](https://bun.sh) 1.4 or later and `git` as well as Docker.

```bash
git clone https://github.com/vredchenko/claude-transcripts.git
cd claude-transcripts
bun install
cp .env.template .env
```

In `.env`: leave `IMAGE_NS` blank (public images). `COUCHDB_USER` / `COUCHDB_PASSWORD`
default to `admin` / `admin`, because CouchDB 3 will not start without an admin; change
both if the machine is shared
([ADR 0020](../design/decisions/0020-bundled-services-default-no-auth.md)). Generate
Garage's cluster secrets and paste them in:

```bash
for k in GARAGE_RPC_SECRET GARAGE_ADMIN_TOKEN GARAGE_METRICS_TOKEN; do
  echo "$k=$(openssl rand -hex 32)"
done
```

Then:

```bash
bun run stack:up:upstream     # CouchDB + Garage + Meilisearch from public images
bun run bootstrap:garage      # layout, bucket, app key; writes S3_* keys into .env
bun run dev:webapi            # :7650; creates databases + views on boot
bun run cli doctor            # end-to-end check
bun run cli setup             # hook config + register the hook (bun run cli setup --check to verify)
bun run cli backfill --dry-run && bun run cli backfill   # adopt existing ~/.claude history
```

With `WEBAPI_PORT` unset the CLI prefers an installed instance's port over 7650; set
`WEBAPI_PORT=7650` in `.env` to point it at the checkout's webapi.
`stack:up:local` builds the app image from the checkout and runs it in the stack
instead of `dev:webapi`. Data lives under `deploy/data/`; delete it to reset. Restart
the webapi after `bootstrap:garage` if it was already running, since S3 credentials
are read at startup.

A hook registered by `setup` from a checkout runs `bun run <clone>/packages/cli/src/cli.tsx
hook run`, so keep the clone in place and `bun` on `PATH`. More in
[hook-setup.md](hook-setup.md).

## Ports

Defaults, all bound to `127.0.0.1` with no app-level auth. Each is an `.env` variable
(`install` picks a free block from `--port-base`).

| Port | Service | Port | Service |
|------|---------|------|---------|
| 7650 | webapi (`WEBAPI_PORT`) | 7654 | Garage admin API |
| 7651 | webui dev server | 7655 | Garage web UI |
| 7652 | CouchDB, Fauxton at `/_utils/` | 7656 | Meilisearch |
| 7653 | Garage S3 API | 7657 | Meilisearch UI |

7658–7661 are reserved.

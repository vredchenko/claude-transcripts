# Installation & first run — design

**Status: design, not built.** This specifies the end-user install path before any of
it is written. It is aimed at **users**, not contributors: someone who wants their
Claude Code sessions recorded and has never seen this repo.

The contributor path (`git clone` → `bun install` → `stack:up` → `dev:webapi`) stays
exactly as it is. Nothing here replaces it.

## The goal

One command, and afterwards sessions are being recorded:

```sh
curl -fsSL https://<host>/install.sh | sh
```

Everything else — a container stack, three backing services, generated secrets, store
provisioning, a hook registered with Claude Code — is an implementation detail the user
should never have to sequence by hand.

Underneath, every step stays a separate, runnable operation. The unified command is a
**composition**, not a monolith: `install` orchestrates steps that each work on their
own, so a partial failure is resumable and an expert can drive one piece.

## The problem this has to solve first

The current steps can't run for a user at all, because **they are all repo-rooted**:

| Step | Needs |
|------|-------|
| `cli setup` | `<repo>/config/`, `<repo>/.env`, `<repo>/hooks/hooks.json`, and registers `bun run <repo>/hooks/scripts/dispatch.ts` |
| `scripts/stack.ts` | `<repo>/deploy/docker-compose*.yml`, `<repo>/.env` |
| `scripts/bootstrap-garage.ts` | `<repo>/.env` (reads **and writes** it) |

A released binary has no repo. Three things follow, and they are the real design
decisions:

1. **The hook command must not be `bun run <repo>/…/dispatch.ts`.** It should be the
   installed CLI itself — `claude-transcripts hook run`. That drops both Bun and the
   repo from the user's dependencies, makes hook behaviour upgrade atomically with the
   binary, and starts faster (no transpile per event). It also removes the reason
   `sumTranscriptTokens` was duplicated byte-identically between `shared` and `hooks/`
   — since done, so there is now one writer. The plugin form
   (`hooks/.claude-plugin/`) stays, as a shim that delegates to the same binary.
2. **Deployment assets must live outside the repo.** The compose files and config
   template need a home under the user's data dir, version-matched to the binary.
   Either embedded in the binary and written out, or fetched from the release.
3. **`.env` is not a user-authored file.** Today `stack.ts` fails with "copy
   `.env.template` to `.env` and fill it in (IMAGE_NS, garage secrets)" — an
   unacceptable first-run experience, and secrets nobody should be inventing by hand.
   Install **generates** it.

## Filesystem layout

XDG, with no repo anywhere:

```
~/.local/bin/claude-transcripts          the binary (and the hook command)
~/.config/claude-transcripts/
    config.json                          hook runtime config (0600) — already written by setup
    instance.env                         generated secrets + ports (0600)
    config.json.d/                       room for the multi-file config config/ grows into
~/.local/share/claude-transcripts/
    deploy/docker-compose*.yml           version-matched deployment assets
    version                              what the assets were installed for
~/.claude/settings.json                  hook registration (merged, never clobbered)
```

Docker volumes keep the actual data, so reinstalling never touches history.

## Command surface

```
claude-transcripts install      [--yes] [--no-hook] [--port-base N] [--dir PATH] [--version V]
claude-transcripts uninstall    [--purge]
claude-transcripts upgrade
claude-transcripts doctor
```

`install` is the composition. Each phase is also reachable on its own, which is what
makes the whole thing resumable and debuggable:

```
claude-transcripts stack up|down|logs|ps      wraps docker compose (today: scripts/stack.ts)
claude-transcripts provision                  stores: couch dbs + migrations, garage, meili
claude-transcripts hook install|uninstall|status
claude-transcripts config init|show|edit
```

Moving `stack` and `provision` out of `scripts/` and into the CLI is required anyway:
`scripts/` is dev-only by the repo's own rule, and a user has no `scripts/`.

## Install phases

Each phase is idempotent, states what it's about to do, and on failure says which
single command resumes from there.

**0. Preflight — decide up front whether this can work.** Nothing is written until
every check passes, so a doomed install fails in seconds having changed nothing:
platform/arch supported; `docker` present, daemon reachable, and `docker compose` (v2)
available; the user can actually talk to the daemon; required ports free; enough disk;
Claude Code's config dir discoverable. Report *all* failures at once with fixes, not
the first one.

**1. Acquire.** Fetch the binary for the platform, verify its checksum, install to
`~/.local/bin`, warn if that isn't on `PATH`. Write the deployment assets for exactly
this version. Everything is pinned — CLI, app image tag, compose file and schema
migrations move together under lockstep versioning
([ADR 0023](decisions/0023-lockstep-versioning-and-combined-image.md)).

**2. Configure.** Generate `instance.env`: random CouchDB admin password, Garage RPC
secret, admin and metrics tokens, and — unlike today's dev default — a Meilisearch
master key. Resolve the port block, honouring what's actually free. Write
`config.json` from the template. One generated file is the source of truth for
ports and secrets; nothing else may hold a second copy.

**3. Start backing services.** `docker compose up -d` with public upstream images.
Wait on real health, not `docker ps`: CouchDB `/_up`, Garage health, Meilisearch
`/health`, each with a timeout and the container's own logs on failure.

**4. Provision.** CouchDB databases + migrations; Garage layout, bucket, access key —
then write the generated S3 keys back into `instance.env`; Meilisearch indexes. This
phase has ordering the current scripts only get away with because a human is driving:
**Garage's S3 keys don't exist until after Garage is running**, so anything holding
them (the app container) has to start, or restart, after this.

**5. Start the app.** The combined image (webapi + SPA + docs + bundled CLI), pinned
to this version. Wait for `/health` to report `ok` — which means stores usable, not
just process alive.

**6. Register the hook.** Write the hook runtime config, then merge our events into
`~/.claude/settings.json`, preserving every other tool's hooks. Claude Code snapshots
hook config at session start, so tell the user that open sessions won't log until
restarted — a real footgun otherwise.

**7. Verify and hand over.** Run `doctor` as the acceptance test: it writes a synthetic
session through the whole path and reads it back. Then print the UI URL, where data
lives, and how to uninstall. If `doctor` fails, install failed — say so plainly rather
than printing a success banner over a broken install.

## Edge cases

The ones that will actually happen, and what each should do.

**Environment**
- *Docker missing.* Hard stop with per-platform instructions. Never auto-install — it
  needs root and differs per distro.
- *Daemon not running / permission denied.* Distinguish these: "start Docker Desktop"
  vs "add yourself to the `docker` group and re-login" are different fixes, and
  `permission denied on /var/run/docker.sock` is the most common first-run failure on
  Linux.
- *Only `docker-compose` v1, or Podman.* Detect and say so. v1 is unsupported.
- *Rootless Docker.* Works, but port binding and volume ownership differ — detect and
  note it rather than failing confusingly later.
- *Port already taken.* Offer the next free block; never silently bind elsewhere,
  because the hook config, services menu and printed URLs must all agree.
- *No internet / air-gapped.* Fails at image pull. Detect early and name it.
- *`~/.local/bin` not on `PATH`.* Install anyway; print the exact line to add.

**Existing state**
- *Re-run of a completed install.* Must be a no-op that re-verifies, not a reinstall.
- *Resume after a partial failure.* Every phase re-entrant; nothing assumes a clean
  slate.
- *An older version is installed.* That's `upgrade`: new binary, new assets, new image
  tag, `migrate up`. Migrations run forward only, and never on a downgrade.
- *Existing `.env`/config from a contributor checkout.* Don't touch the repo. The
  user install is a separate instance under `~/.config`.
- *Existing volumes with real history.* Never destroyed by install, upgrade, or plain
  uninstall. Only `uninstall --purge` removes data, and only on explicit confirmation.
- *`--port-base` on an existing instance.* Ignored, and deliberately: the instance env
  is back-filled rather than regenerated, so nothing already provisioned gets a value
  changed underneath it. Moving an existing instance's ports means editing
  `instance.env` (with the stack down) or uninstalling first.
- *A contributor's dev stack already running.* Compose uses fixed container names, so
  a second instance collides rather than starting alongside — the visible consequence
  of "one instance per machine". Take the dev stack down first, or don't run `install`
  on a development machine.
- *Hook already registered — ours.* Leave it, or update the command if the path moved.
- *Hook already registered — someone else's.* Merge alongside. Never rewrite another
  tool's entry.
- *Claude Code not installed yet.* Not fatal. Write the registration; it applies when
  Claude Code appears.

**Runtime and safety**
- *A backing service never becomes healthy.* Time out, print that container's logs,
  and leave the stack up for inspection — tearing it down destroys the evidence.
- *Garage bootstrap partially applied.* Already idempotent: skip layout if assigned,
  reuse the bucket, no-op if keys exist. Keep that property.
- *Stack down later.* Sessions must still work. The hook never blocks
  ([ADR 0016](decisions/0016-webapi-is-the-io-gateway.md)); worst case, history for
  that session is lost, and `backfill` can adopt it afterwards from `~/.claude`.
- *Non-interactive (`--yes`, CI).* No prompts; every decision takes a documented
  default; a decision that can't be defaulted safely is an error, not a guess.
- *Uninstall.* Deregister the hook, stop the stack, remove binary and assets. Data
  survives unless `--purge`. Must work even if the stack is already gone.

## The `install.sh` wrapper

Deliberately tiny, because bash is the wrong place for any of this. Its entire job:

1. detect OS/arch,
2. resolve the release version (latest, or `CT_VERSION`),
3. download the matching binary **and verify its checksum**,
4. place it in `~/.local/bin`,
5. `exec claude-transcripts install "$@"`.

No provisioning, no Docker calls, no config generation, no JSON editing. Anything the
wrapper does can't be tested, reused by `upgrade`, or run by someone who already has
the binary. It must also be safe to pipe from `curl`: pinned version, checksum
verified, refusing to run on an unsupported platform, and idempotent.

## Decisions

1. **Assets are embedded in the binary.** Compose files and the config template are
   inlined into a generated module and written out at install time, so install is a
   single artifact with no second download and no way for assets to drift from the
   code that drives them. Regenerated by `bun run gen:assets` and committed, like the
   other generated files.
2. **Meilisearch supports a master key, and defaults to none.** Keeping the default
   keyless stays consistent with
   [ADR 0020](decisions/0020-bundled-services-default-no-auth.md) (bundled services,
   localhost, no auth). `MEILI_MASTER_KEY` in the instance env turns it on, and the
   whole path — compose, webapi, and the CLI's own calls — honours it, so hardening a
   deployment is one setting rather than a code change.
3. **`install` runs the app container.** Users get the combined image
   ([ADR 0023](decisions/0023-lockstep-versioning-and-combined-image.md)); the
   host-run webapi stays the contributor path.
4. **One instance per machine.** Ports, container names, the data dir and Meilisearch
   index names are all unnamespaced, and staying that way keeps install simple.
   Multi-instance would need all four namespaced — see
   [ADR 0028](decisions/0028-external-vs-bundled-meilisearch.md) for the index half.

### Consequences worth naming

Deciding the hook is the CLI binary retired the reason `sumTranscriptTokens` was kept
byte-identical in two places: the duplication existed only because "the hook can't
resolve the workspace at install time", which stopped being true once the hook *is* the
installed binary. The plugin under `hooks/` no longer carries its own copies — it pipes
the payload to `claude-transcripts hook run`, so there is one writer.

## Acceptance

Install is done when, on a clean machine with only Docker and Claude Code:

- one piped command completes with no prompts and no manual file editing;
- `doctor` passes;
- a real Claude Code session appears in the UI;
- re-running install changes nothing;
- `uninstall` leaves no trace but the data, and `--purge` removes that too.

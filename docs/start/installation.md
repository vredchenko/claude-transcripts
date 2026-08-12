# Installation

Standing up Claude Transcripts on one machine, end to end: backing services, the
app, and the hook that records your sessions.

> **Not tested as ready for use.** No installation has been walked end to end on a
> clean machine yet. Expect rough edges, and treat anything you store as
> disposable. See [the project status](../README.md).

## Quick install

```sh
curl -fsSL https://raw.githubusercontent.com/vredchenko/claude-transcripts/main/install.sh | sh
```

That fetches the release binary for your platform, verifies its checksum, and runs
`claude-transcripts install`, which does everything below for you: generates this
instance's secrets and ports, starts the backing services, provisions the stores,
starts the app, and registers the hook with Claude Code. It needs **Docker** and
**Claude Code** — nothing else, not even Bun.

Already have the binary? Just run:

```sh
claude-transcripts install      # idempotent — safe to re-run
claude-transcripts doctor       # verify the whole write→read path
```

Useful flags: `--port-base N` (move the port block), `--meili-key` (turn on
Meilisearch auth), `--no-hook` (set up the stores but don't register with Claude
Code), `--no-app` (run the webapi yourself), `--no-prune` (keep the app images this
upgrade superseded). Removing it again:

```sh
claude-transcripts uninstall            # keeps your recorded history
claude-transcripts uninstall --purge    # deletes it too (asks first)
```

Install is a composition, so any phase can be re-run on its own — `stack up`,
`provision`, `hook install` — and a failure tells you which one resumes from there.
The design, including the edge cases it handles, is in
[installation.md (design)](../design/installation.md).

**Open Claude Code sessions won't be recorded until you restart them**: Claude Code
reads its hook configuration when a session starts.

The rest of this page covers doing it by hand — useful for a custom topology, for
contributing, or for understanding what the one command actually did.

## What you are installing

| Piece | Required? | What it does |
|-------|-----------|--------------|
| **CouchDB** | yes | The source of truth — events, summaries, chunked content |
| **S3-compatible storage** | recommended | Transcript blobs (bundled: [Garage](https://garagehq.deuxfleurs.fr)) |
| **Meilisearch** | optional | Search index; off ⇒ no search, nothing else changes |
| **webapi** | yes | The only process that talks to the stores |
| **webui** / **cli** | optional | Ways to read it back |
| **the hook** | yes, to record | Registered with Claude Code; writes each session |

## Prerequisites

For the quick install: [Docker](https://docs.docker.com/get-docker/) with Compose v2,
and [Claude Code](https://claude.com/claude-code). The binary carries everything else.

For the manual path below, additionally: [Bun](https://bun.sh) ≥ 1.1 and `git`.

## Choose a topology

- **Bundled** — Docker Compose runs CouchDB + Garage + Meilisearch locally from
  public images. This is the supported path and the rest of this page assumes it.
- **External** — you already run these services; only the app runs locally. The
  plumbing exists (each backend takes a URL) but has **not** been verified. See
  [configuration.md](configuration.md#backend-topology--bundled-or-external).

## Ports

Defaults are `7650–7661`, bound to `127.0.0.1`, no auth. Every one is an `.env`
variable, and `.env` feeds both Compose and the host-run app — so if something
already listens on a port, change the number there and everything follows.

| Port | Service | | Port | Service |
|------|---------|-|------|---------|
| 7650 | webapi | | 7654 | Garage admin API |
| 7651 | webui (dev server) | | 7655 | Garage web UI |
| 7652 | CouchDB (+ Fauxton at `/_utils/`) | | 7656 | Meilisearch |
| 7653 | Garage S3 API | | 7657 | Meilisearch UI |

## 1. Clone and install

```bash
git clone git@github.com:vredchenko/claude-transcripts.git
cd claude-transcripts
bun install
```

## 2. Secrets

```bash
cp .env.template .env
```

Leave `IMAGE_NS` blank (public images). `COUCHDB_USER` / `COUCHDB_PASSWORD`
default to `admin` / `admin`: CouchDB 3 refuses to start without an admin, so the
bundled stack ships one rather than nothing — change both if this box is not
your own ([ADR 0020](../design/decisions/0020-bundled-services-default-no-auth.md)).
The same credentials log you into Fauxton at `:7652/_utils/`.

Generate Garage's internal cluster secrets:

```bash
for k in GARAGE_RPC_SECRET GARAGE_ADMIN_TOKEN GARAGE_METRICS_TOKEN; do
  echo "$k=$(openssl rand -hex 32)"
done
```

`S3_ACCESS_KEY` / `S3_SECRET_KEY` stay empty — step 4 writes them for you.
Non-secret settings (database and bucket names, feature flags) come from
`config/` and need no copying; see [configuration.md](configuration.md).

## 3. Start the backing services

```bash
bun run stack:up:upstream            # public images, no registry needed
bun run scripts/stack.ts ps --upstream
```

State lives under `deploy/data/` — delete it to reset the world.

## 4. Bootstrap Garage

S3 signs every request, so a bucket and key must exist before the app can store
anything. One idempotent command assigns the cluster layout, creates the bucket
and an app key, grants access, and writes the keys into `.env`:

```bash
bun run bootstrap:garage
```

If your Garage's admin API differs, the script prints the endpoint and response;
the CLI equivalents are in the [repository README](../../README.md).

## 5. Run the app

On the host, for fast iteration:

```bash
bun run dev:webapi                   # http://127.0.0.1:7650 — creates DBs + views on boot
bun run dev:webui                    # http://127.0.0.1:7651/app/
```

Or as a container — the combined image serves the API and the SPA together:

```bash
bun run stack:up:local               # builds + runs the app container
```

Restart the webapi after step 4 if it was already running: S3 credentials are
read at startup.

## 6. Verify

```bash
bun run cli doctor
```

This writes one synthetic session through the webapi and reads it back, proving
CouchDB and S3 are wired. Then `bun run cli sessions` should list it.

## 7. Record real sessions

```bash
bun run cli setup                    # verify later with: bun run cli setup --check
```

Writes `~/.config/claude-transcripts/config.json`, ensures the databases, probes
the bucket, and registers the hook in `~/.claude/settings.json`. Details and
per-project scope: [hook-setup.md](hook-setup.md).

The hook runs from this clone, so keep it in place and keep `bun` on your `PATH`.
It never blocks a session — if the stack is down, events are dropped.

## 8. Adopt existing history

```bash
bun run cli backfill --dry-run       # preview
bun run cli backfill                 # adopt on-disk ~/.claude transcripts
```

## Where to go next

- [configuration.md](configuration.md) — everything you can change
- [hook-setup.md](hook-setup.md) — hook installation in depth
- [compatibility.md](compatibility.md) — which Claude Code versions are covered
- [../develop/getting-started.md](../develop/getting-started.md) — if you mean to
  work on the project itself

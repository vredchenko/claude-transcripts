# Claude Transcripts

[![Built with Claude Code](https://img.shields.io/badge/Built%20with-Claude%20Code-CC785C?logo=anthropic&logoColor=white)](https://claude.com/claude-code)

**Self-hosted history for your [Claude Code](https://claude.com/claude-code)
sessions.** A Claude Code hook logs every session — events, an end-of-session
summary (counts, tool usage, token usage), and the full transcript — to your own
**CouchDB** + **S3-compatible** storage. A web API serves it back; a web UI and a
CLI (and AI agents) read it.

Everything runs on your own infrastructure. Nothing leaves your network.

```
Claude Code ──hook──► webapi ──► CouchDB + S3        webui ─┐
                        ▲                             cli  ──┼─► webapi
                        └───────── reads/writes ──────agents┘
```

> **Status:** early rebuild. Tier 1 (single machine, single user) first — retention,
> browse/search, and programmatic access, no auth. A public project website and
> hosted docs are planned (GitHub Pages); for now the design lives in
> [`docs/`](docs/).

## Getting started (localhost, single machine)

Runs entirely on your machine on ports `7650–7661`, no auth (localhost only). The
backing services come from **public** Docker images and the app runs on the host
via Bun — so nothing needs to be built or published to try it.

**Prerequisites:** [Docker](https://docs.docker.com/get-docker/) (with Compose),
[Bun](https://bun.sh) ≥ 1.1, `git`, `openssl`, and
[Claude Code](https://claude.com/claude-code) (to record sessions).

### 1. Clone and install

```bash
git clone git@github.com:vredchenko/claude-transcripts.git
cd claude-transcripts
bun install
```

### 2. Configure secrets

```bash
cp .env.template .env
```

In `.env`: leave `IMAGE_NS` blank (we use public images) and leave
`COUCHDB_USER`/`COUCHDB_PASSWORD` blank (the bundled stack has no auth). Generate
Garage's internal cluster secrets and paste them in:

```bash
for k in GARAGE_RPC_SECRET GARAGE_ADMIN_TOKEN GARAGE_METRICS_TOKEN; do
  echo "$k=$(openssl rand -hex 32)"
done
```

Leave `S3_ACCESS_KEY` / `S3_SECRET_KEY` empty for now — you fill them in step 4.
App config (DB/bucket names, ports) comes from
[`config/config.template.json`](config/config.template.json) automatically; you
don't need to copy it.

### 3. Start the backing services (public images)

```bash
bun run stack:up:upstream          # CouchDB, Garage, Meilisearch + admin UIs
bun run scripts/stack.ts ps --upstream
```

CouchDB → `:7652` (Fauxton at `/_utils/`), Garage S3 → `:7653` (web UI `:7655`),
Meilisearch → `:7656`. State lives under `deploy/data/` (delete it to reset).

### 4. One-time Garage bootstrap (create the bucket + an app key)

S3 always signs requests, so create a bucket and a key once:

```bash
G="docker exec claude-transcripts-garage /garage"
$G status                                  # note this node's ID
$G layout assign -z dc1 -c 1G <NODE_ID>    # <NODE_ID> from the line above
$G layout apply --version 1
$G bucket create claude-transcripts-sessions
$G key create claude-transcripts-app       # prints a Key ID + Secret — copy both
$G bucket allow --read --write claude-transcripts-sessions --key claude-transcripts-app
```

Paste the Key ID → `S3_ACCESS_KEY` and the Secret → `S3_SECRET_KEY` in `.env`.
(Commands may vary slightly by Garage version — see the
[Garage quick-start](https://garagehq.deuxfleurs.fr/documentation/quick-start/).)

### 5. Run the app (on the host)

```bash
bun run dev:webapi     # http://127.0.0.1:7650  — creates the CouchDB DBs + views on boot
# in a second terminal:
bun run dev:webui      # http://127.0.0.1:7651/app/
```

### 6. Smoke-test the write → read path

```bash
bun run cli doctor
```

Expect all checks ✓ — it writes one synthetic session through the webapi and reads
it back (verifying CouchDB + S3 are wired). Then list it: `bun run cli sessions`.

### 7. Record real sessions — install the hook

```bash
bun run cli setup            # verify later with: bun run cli setup --check
```

This writes `~/.config/claude-transcripts/config.json`, ensures the CouchDB
databases, probes the Garage bucket, and registers the logging hook in
`~/.claude/settings.json` for all session events. Now run Claude Code anywhere —
each session is logged; browse them at http://127.0.0.1:7651/app/.

> The hook runs `bun run <repo>/hooks/scripts/dispatch.ts`, so keep this clone in
> place and `bun` on your `PATH`. It never blocks a session — if the stack is down,
> events are simply dropped.

### 8. Backfill existing history

```bash
bun run cli backfill --dry-run     # preview what would be adopted
bun run cli backfill               # adopt on-disk ~/.claude transcripts as history
```

## Configuration

Non-secret deployment-wide settings live in [`config/`](config/) (copy
[`config/config.template.json`](config/config.template.json) → `config/config.json`);
secrets/endpoints in a local `.env` (copy [`.env.template`](.env.template)). The
bundled dev stack runs on ports `7650–7661` with no auth on localhost.

---

## For developers

Everything below is for working **on** Claude Transcripts, not just running it.

### Components

| Component | Path | Role |
|-----------|------|------|
| **hooks** | `hooks/` | Claude Code plugin (writer). Logs sessions; installs per machine. |
| **webapi** | `packages/webapi/` | Bun + Hono gateway: the single I/O surface; serves the SPA in prod. |
| **webui** | `packages/webui/` | React + MUI SPA (optional). |
| **cli** | `packages/cli/` | Bun + Ink user-facing tool + admin utility (optional). |
| **shared** | `packages/shared/` | The app model (central state) + cross-cutting types + token accounting. |
| **scripts** | `scripts/` | Dev-only automation (client gen, image mirroring, release). |
| **deploy** | `deploy/` | Docker Compose: CouchDB + Garage + Meilisearch + admin UIs. |

### Container-based deploy

For a container deploy (rather than running on the host), the combined **app**
image (`claude-transcripts-app`, webapi + prebuilt webui SPA) is published to GHCR
by the `publish-image` GitHub Actions workflow on a `vX.Y.Z` tag
([ADR 0023](docs/decisions/0023-lockstep-versioning-and-combined-image.md)). The
default (non-`--upstream`) stack mode pulls mirrored backing images from your own
`${IMAGE_NS}` registry; `--upstream` uses public upstream images instead.

### Docs & conventions

- [`docs/`](docs/) — architecture, ADRs, and the data model (the spec).
- [`CLAUDE.md`](CLAUDE.md) — build conventions and repo invariants for agents.
- **Bun** workspace monorepo, TypeScript (ESM, strict); **Biome** formatting;
  **lefthook** pre-commit. `bun run lint`, `bun run typecheck`, `bun run build`.

## License

[MIT](LICENSE)
</content>
</invoke>

# Getting started (development)

For working **on** Claude Transcripts. If you only want to run it, start at
[installation.md](../start/installation.md) instead.

## Set up

```bash
git clone git@github.com:vredchenko/claude-transcripts.git
cd claude-transcripts
bun install
cp .env.template .env
```

Then bring up the backing services and bootstrap storage exactly as an operator
would — [installation.md](../start/installation.md) steps 3 and 4. Development
assumes the **backing services run in Docker** while **webapi, webui, and the CLI
run on the host**, so you get instant reloads without rebuilding an image.

```bash
bun run dev:webapi     # http://127.0.0.1:7650
bun run dev:webui      # http://127.0.0.1:7651/app/  (proxies /api → webapi)
bun run cli doctor     # end-to-end write → read check
```

## The checks that gate a PR

```bash
bun run lint           # biome
bun run typecheck
bun run build
bun run test
```

CI runs exactly these four ([ci.yml](../../.github/workflows/ci.yml)); lefthook
runs Biome on staged files at commit time. Nothing else gates a merge.

## How the pieces fit

```
Claude Code ──hook──► webapi ──► CouchDB + S3        webui ─┐
                        ▲                             cli  ──┼─► webapi
                        └───────── reads/writes ──────agents┘
```

| Path | What it is |
|------|------------|
| `hooks/` | A thin Claude Code **plugin wrapper**: `scripts/dispatch.ts` pipes each payload to `claude-transcripts hook run`. The writer itself is `packages/cli/src/hook/`. Installs per machine. |
| `packages/webapi/` | Bun + Hono gateway. **The only thing that touches CouchDB or S3.** Serves the SPA and docs in production. |
| `packages/webui/` | React + Vite + MUI SPA. Optional. |
| `packages/cli/` | Bun + Ink CLI — user-facing *and* the admin utility (`setup`, `doctor`, `backfill`, export/import). Optional. |
| `packages/shared/` | The app model (central state), cross-cutting types, token accounting. |
| `scripts/` | Dev-only automation. Not shipped to users. |
| `config/` | Non-secret deployment config (`config.template.json` → `config.json`). |
| `deploy/` | Compose stack for the backing services. |

## Rules worth knowing before your first change

These are the ones that bite if you don't know them — the full set is in
[conventions.md](conventions.md) and the repo's `CLAUDE.md`.

- **The webapi is the I/O gateway.** Nothing reads a backend directly, and no consumer
  writes to one — with one deliberate exception: the **hook** writes to CouchDB and S3
  itself, so recording a session never depends on the webapi being up
  ([ADR 0016](../design/decisions/0016-webapi-is-the-io-gateway.md#amendment-the-hook-is-a-second-writer)).
- **The OpenAPI spec is the contract.** The webui and CLI use *generated* clients
  (`bun run gen:clients`) — don't hand-write request code
  ([ADR 0019](../design/decisions/0019-openapi-source-of-truth-generated-clients.md)).
- **Documents are append-only.** New information is a new document referencing
  `session_id`, never an edit in place — that keeps future replication
  conflict-free. Schema changes go through [migrations](../operate/migrations.md).
- **Extend the app model, don't re-derive it.** Compose files, the manifest, and
  the seed plan are *projections* of `packages/shared/src/model/` — change the
  model and regenerate.
- **There is one writer.** The CLI (`packages/cli/src/hook/`) is the hook and
  imports `@claude-transcripts/shared` directly; `hooks/` is a shim that pipes the
  payload to `claude-transcripts hook run`. Don't reintroduce a second copy of
  `sumTranscriptTokens` or the chunking helpers.
- **The hook must never block a session.** Every external call is wrapped; a dead
  stack means dropped events, not a stalled Claude Code.

## Working on a change

Branch off `main`, open a PR, merge back — [branching.md](branching.md) and
[ADR 0026](../design/decisions/0026-single-main-branch.md). Generated artefacts
(API clients, compose, hook-event tables, compatibility matrix) are regenerated
by the scripts in [dev-automation.md](dev-automation.md), not edited by hand.

## Next

- [development.md](development.md) — the fuller development reference
- [testing.md](testing.md) — what is tested and how
- [dev-automation.md](dev-automation.md) — the generators
- [../operate/releasing.md](../operate/releasing.md) — cutting a release
- [../design/architecture.md](../design/architecture.md) — why it's shaped this way

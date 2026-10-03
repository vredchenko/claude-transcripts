# Getting started (development)

For working on Claude Transcripts. To run it, see
[installation.md](../start/installation.md).

## Set up

```bash
git clone https://github.com/vredchenko/claude-transcripts.git
cd claude-transcripts
bun install                   # Bun 1.4+; also installs the lefthook pre-commit hook
cp .env.template .env         # then add Garage secrets, see installation.md "From source"
bun run stack:up:upstream     # CouchDB + Garage + Meilisearch in Docker
bun run bootstrap:garage      # bucket + app key, written into .env
```

Backing services run in Docker; the webapi, webui and CLI run on the host, so changes
reload without rebuilding an image:

```bash
bun run dev:webapi            # http://127.0.0.1:7650
bun run dev:webui             # http://127.0.0.1:7651/app/ (proxies /api to the webapi)
bun run cli doctor            # end-to-end write → read check
```

Plain `stack:up` pulls images from `${IMAGE_NS}` (your registry mirror);
`stack:up:upstream` uses public images. If you also have an installed instance, take
one stack down first (container names collide) and run `setup` with `--no-hook` so the
checkout doesn't register a second logger.

## Before you push

```bash
bun run typecheck && bun run lint && bun test
```

CI (`ci.yml`) also requires: `gen:clients` and `gen:all` leave no diff,
`check:contract`, `build:docs`, the test suite on the minimum supported Bun, and the
Playwright browser suite. `bun run test:e2e` runs the full write → read path against a
running stack and webapi ([testing.md](testing.md)).

## Branches and PRs

- `main` is the only long-lived branch ([ADR 0026](../design/decisions/0026-single-main-branch.md));
  never push to it directly.
- Work on `feat/<topic>`, `fix/<topic>` or `chore/<topic>` off `main`, one change per
  PR, and let CI go green before merging.
- Rebase is the only merge strategy enabled. Rebase adds no `(#N)` suffix, so reference
  the PR or issue in the commit message.
- Releases are cut from `main` by tag ([releasing.md](../operate/releasing.md)).

## Layout

![Claude Code fires a hook that writes events, summaries and transcripts directly to CouchDB and S3; the webapi gateway reads them back for the web UI, the CLI and agents.](../assets/architecture.svg)

| Path | What it is |
|------|------------|
| `packages/shared/` | The app model (`src/model/`, including `CLI_SPEC`), the migrations engine, cross-cutting types, `sumTranscriptTokens`. |
| `packages/webapi/` | Bun + Hono gateway. All reads of CouchDB and S3 go through it. Serves the SPA, docs and CLI binary in production. |
| `packages/webui/` | React + Vite + MUI SPA. Optional. |
| `packages/cli/` | Bun + Ink CLI: user commands, admin commands, and the hook itself (`src/hook/`). |
| `hooks/` | The Claude Code plugin: a shim that pipes each payload to `claude-transcripts hook run`, plus skills and a slash command. |
| `scripts/` | Dev-only automation ([dev-automation.md](dev-automation.md)). User-useful operations go in `packages/cli/` instead; there is no `tools/` directory. |
| `config/` | `config.template.json`, copied to the gitignored `config.json`. |
| `deploy/` | Generated Compose files, and a generated kustomize base in `deploy/k8s/`. |
| `tests/` | e2e and Playwright suites, and a mock Claude Code. |
| `docs/` | This tree. `site/` is the landing page. |

Naming: codename and slug `claude-transcripts`, title "Claude Transcripts", packages
scoped `@claude-transcripts/*`, app env vars prefixed `CT_`. Code style: TypeScript
(ESM, strict), Biome (2-space indent, double quotes, semicolons, width 100). Dev ports
are 7650–7661 ([table](../start/installation.md#ports)).

## Rules that bite

The full set is in [`CLAUDE.md`](../../CLAUDE.md).

- **The webapi is the I/O gateway.** Consumers read through it and write only through
  its curated routes. The exception is the hook, which writes to CouchDB and S3
  directly so recording never depends on the webapi
  ([ADR 0016](../design/decisions/0016-webapi-is-the-io-gateway.md#amendment-the-hook-is-a-second-writer)).
  That is why the `_changes` follower exists and why hook-written docs get no
  write-time validation.
- **Extend the app model, don't re-derive it.** Compose files, the k8s base, the
  manifest at `/`, hook registration and the CLI reference are projections of
  `packages/shared/src/model/`. Change the model and regenerate.
- **The OpenAPI spec is the contract.** The webui and CLI use generated clients
  (`bun run gen:clients`); don't hand-write request code
  ([ADR 0019](../design/decisions/0019-openapi-source-of-truth-generated-clients.md)).
- **`CLI_SPEC` declares every command and flag.** An undeclared flag is rejected before
  the command runs.
- **Generated files are committed and never hand-edited.** `bun run gen:all`
  regenerates them; CI fails on a diff.
- **Documents are append-only.** New information is a new doc referencing
  `session_id`. View and schema changes go through
  [migrations](../operate/migrations.md).
- **One writer.** The hook lives in `packages/cli/src/hook/` and imports `shared`; don't
  reintroduce a second copy of `sumTranscriptTokens` or the chunking helpers.
- **The hook never blocks a session.** Every external call is wrapped; a dead stack
  means dropped events, not a stalled Claude Code.
- **No environment specifics** in anything committed: no hostnames, personal paths or
  secrets. This is a public project.

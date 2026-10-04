# CLAUDE.md

Project context for agents working in this repo. Keep this current.

## Naming (conventions)

- **Codename:** `claude-transcripts`
- **Slug** (repo / package / container): `claude-transcripts`
- **Verbose title:** Claude Transcripts

Use these consistently across code, config, and docs.

## What this is

**Claude Transcripts** (`claude-transcripts`) — self-hosted history for
Claude Code sessions. A Claude Code **hook** (writer) logs every session to
**CouchDB + S3 (Garage)**; a **webapi** gateway serves it back; a **webui** and a
**cli** (and AI agents) read it. Built fresh as a Bun + TypeScript monorepo.

> `docs/` holds the full technical design — tiers, architecture, ADRs, data model.
> Treat it as the spec.

## This is a public project — build for everyone

This is a **public FOSS repo** with users who are not the maintainer. Everything
committed — code, config, docs, ADRs, defaults, error messages — is read by people
running their own instance on their own machines. So:

- **Solve the general case, not the maintainer's case.** A need that only the
  maintainer has (say, a one-off import from some predecessor project's schema, or a
  quirk of one particular machine) does not belong in the repo. Either generalise it
  into a feature anyone would use, or keep it out of tree.
- **No environment specifics**: no internal hostnames, IPs, personal paths, machine
  names, account names, or secrets in code, config, docs or fixtures. Ship sane
  defaults and make the rest configurable.
- **Assume the reader knows nothing about this deployment.** Docs and messages should
  make sense to someone who just cloned the repo; don't lean on context that only
  exists in the maintainer's head or in one instance's history.
- **Don't assume our own topology.** Backing services may be bundled or external, on
  any host, with or without auth ([ADR 0020](docs/design/decisions/0020-bundled-services-default-no-auth.md),
  [ADR 0028](docs/design/decisions/0028-external-vs-bundled-meilisearch.md)).

When a request is genuinely one user's need, the right move is usually to build the
generic capability it's an instance of — and say so.

## Local development

```
bun install
bun run typecheck && bun run lint && bun test   # verify a change
bun run gen:clients                             # regenerate API clients after a contract change
bun run stack:up:upstream                       # CouchDB + Garage + Meili (plain stack:up needs IMAGE_NS)
bun run dev:webapi / dev:webui / dev:cli        # run a component
bun run test:e2e                                # full write→read path (needs stack + webapi up)
```

`bun run gen:all` refreshes every generated artifact (hooks bindings, hook-events doc,
architecture diagram, compose files, k8s base, inlined deploy assets, CLI reference).
Generated files are committed — regenerate, don't hand-edit; CI re-runs `gen:all` and
fails on a diff.

## Contributing

- **Git** — `origin` is `github.com:vredchenko/claude-transcripts`. Work on a
  `feat/*` / `fix/*` / `chore/*` branch and merge via PR (**rebase only** — the repo
  has merge- and squash-commits disabled). Committing, pushing a branch and opening a
  PR need no separate say-so: the repo is public and every branch is reviewable, so
  the PR *is* the checkpoint. Never push to `main` directly.
- **One PR per change.** A branch that fixes two unrelated things should be two
  branches. Reviewers read a diff, not a session transcript.
- **CI is the gate**: let `ci.yml` go green on the PR before merging.
- Verify locally first — `bun run typecheck && bun run lint && bun test` — rather
  than using CI to find out.

## Repo structure

Two kinds of components:

1. **Custom components** (`packages/*`) — the code we write:
   - `@claude-transcripts/shared` — the **app blueprint** (central state, `src/blueprint/`) +
     migrations (`src/migrations/`) + cross-cutting types + `sumTranscriptTokens`.
   - `@claude-transcripts/webapi` — Bun + Hono + zod-openapi (+ Scalar at `/api/docs`). The
     **I/O gateway** (exceptions under Key invariants);
     read-only `/api/couch` + `/api/s3` proxies; serves the SPA in prod.
   - `@claude-transcripts/webui` — React + Vite + MUI SPA. Optional interface.
   - `@claude-transcripts/cli` — Bun + Ink. User-facing tool + admin utility, and
     **the writer** (`hook run`, `src/hook/`). Commands: `CLI_SPEC`.
2. **The hook plugin** (`hooks/`) — the Claude Code plugin: a thin shim that pipes each
   hook payload to `claude-transcripts hook run`. Installs separately per machine.

Plus:
- `scripts/` — **dev-only** automation (orval client gen, image mirroring,
  release). Run via `bun run scripts/<name>`; most are wrapped in CI.
- `deploy/` — Docker Compose: CouchDB + Garage + Fossil + Meilisearch + admin UIs; `deploy/k8s/`
  the same stack as a generated kustomize base (ADR 0030).
- `docs/` — design docs + ADRs. `tests/` — e2e, Playwright, mock Claude Code. Also:
  `site/` (landing page), `brand/`, `.claude-plugin/` (marketplace), `install.sh`.

**Operational-utility rule:** dev-only → `scripts/`; user-useful → `packages/cli/`.
There is no `tools/` dir.

## Key invariants

- **Non-secret, deployment-wide config lives in `config/`** — the committed
  `config/config.template.json` is the template (sane defaults), copied to
  `config/config.json` (gitignored, the live instance; the loader falls back to the
  template for zero-config dev). Top-level keys mirror the template; stores are keyed
  maps (`couchdb.databases`, `s3.buckets`, `meilisearch.indexes`) built for **more than
  one** each. Config will grow to **multiple files** under `config/`. `.env` holds only
  secrets/endpoints.
- **The blueprint (`@claude-transcripts/shared` `src/blueprint/`) is the central state** — an
  abstract, isomorphic TS description of the whole app (identity, services/ports,
  stores, hooks, actions, routes, env schema, versions, the CLI spec; an API spec grows in).
  Built once from config + env (`buildAppBlueprint`), held in-memory, served at `/`.
  Consumers **project** from it (`toManifest` → `/`, `toComposeEnv` → stack,
  `toSeedPlan` → seed) — don't re-derive these facts elsewhere; **extend the
  blueprint**. Pure TS, so Bun server and React client both use it.
- **The webapi is the I/O gateway** (stability column): consumers never touch
  CouchDB/S3 directly for **reads**, and writes are never proxied. Two exceptions, both
  deliberate: host-side metadata ingestion (local files the container can't see, still
  delivered *to* the webapi), and **the hook, which writes to CouchDB and S3 directly**
  so that recording a session never depends on the webapi being up
  ([ADR 0016](docs/design/decisions/0016-webapi-is-the-io-gateway.md#amendment-the-hook-is-a-second-writer)).
  That bypass is why the `_changes` follower exists, and why hook-written docs get no
  write-time validation.
- **`CLI_SPEC` is the CLI's source of truth** (`packages/shared/src/blueprint/cli.ts`):
  help, pre-dispatch argument validation, and the generated command reference
  (`bun run gen:cli-docs` → `packages/cli/README.md` + `docs/reference/cli.md`) all
  project from it. Add a flag to the spec, not just to the runner — an undeclared
  flag is rejected before the runner runs. `commands/index.test.ts` keeps the spec and
  the `COMMANDS` registry equal.
- **OpenAPI spec is the contract source of truth**; the webui + cli consume
  clients **generated** from it (orval, `bun run gen:clients`). Don't hand-write
  request code.
- **Append-only / immutable docs.** New info is a new doc referencing `session_id`,
  never an in-place edit — this keeps future CouchDB replication conflict-free.
  Schema/view changes go through the self-built **migrations** (not ad-hoc scripts).
- **CouchDB doc schemas are defined in code** (shared types + validators) and
  validated at the webapi on write.
- **One writer.** The CLI (`packages/cli/src/hook/`) is the hook; `hooks/` is a thin
  plugin shim that pipes the payload to `claude-transcripts hook run`. There is no
  second copy of `sumTranscriptTokens` or the chunking helpers to keep in step — don't
  reintroduce one.
- **Bundled backing services default to no auth**, localhost only; treat empty
  creds as valid for the bundled case.
- The hook **never blocks a session**: every external call is wrapped in try/catch.

## Tiers (scope discipline)

- **Tier 1 (current):** single machine, single user. Retention + browse/search +
  programmatic access. No auth/security. webapi + CouchDB are core; webui, cli,
  Meilisearch, S3 are optional.
- **Tier 2:** make history actively useful (recall, self-learning, analytics,
  multi-user). **Tier 3:** multiplayer + public release.

## Conventions

- **Bun** workspace monorepo, TypeScript (ESM, strict). **Biome** (2-space, double
  quotes, semicolons, width 100); **lefthook** pre-commit.
- Storage is vendor-neutral: CouchDB over HTTP, S3 via env (`S3_*`).
- Dev port range **7650–7661** (see `.env.template` / `deploy/`).

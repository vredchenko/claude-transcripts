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
bun run stack:up                                # bring up CouchDB + Garage + Meilisearch
bun run dev:webapi / dev:webui / dev:cli        # run a component
bun run test:e2e                                # full write→read path (needs stack + webapi up)
```

`bun run gen:all` refreshes every generated artifact (hooks bindings, compose files,
compatibility matrix). Generated files are committed — regenerate, don't hand-edit.

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
   - `@claude-transcripts/shared` — the **app model** (central state, `src/model/`) +
     cross-cutting types + `sumTranscriptTokens`.
   - `@claude-transcripts/webapi` — Bun + Hono + zod-openapi (+ Scalar at `/api/docs`). The
     **I/O gateway**: all reads/writes go through it; read-only `/api/couch` +
     `/api/s3` proxies; serves the SPA in prod.
   - `@claude-transcripts/webui` — React + Vite + MUI SPA. Optional interface.
   - `@claude-transcripts/cli` — Bun + Ink. The **user-facing** tool + admin utility
     (setup, `backfill` (adopt on-disk transcripts), export/import bundles,
     migrate, smoke-test). Optional interface.
2. **The hook** (`hooks/`) — the Claude Code plugin (writer). Installs separately
   per machine.

Plus:
- `scripts/` — **dev-only** automation (orval client gen, image mirroring,
  release). Run via `bun run scripts/<name>` and wrapped in CI.
- `deploy/` — Docker Compose: CouchDB + Garage + Meilisearch + admin UIs.
- `docs/` — design docs + ADRs.

**Operational-utility rule:** dev-only → `scripts/`; user-useful → `cli/`. There is
no `tools/` dir.

## Key invariants

- **Non-secret, deployment-wide config lives in `config/`** — the committed
  `config/config.template.json` is the template (sane defaults), copied to
  `config/config.json` (gitignored, the live instance; the loader falls back to the
  template for zero-config dev). Holds `system` constants, `couchdb.databases` /
  `s3.buckets` (keyed maps — designed for **more than one** DB/bucket), `features`,
  `servicesMenu`, `userSettings`. Config will grow to **multiple files** under
  `config/`. `.env` holds only secrets/endpoints.
- **The app model (`@claude-transcripts/shared` `src/model/`) is the central state** — an
  abstract, isomorphic TS description of the whole app (identity, services/ports,
  stores, hooks, actions, routes, env schema, versions; api/cli specs grow in).
  Built once from config + env (`buildAppModel`), held in-memory, served at `/`.
  Consumers **project** from it (`toManifest` → `/`, `toComposeEnv` → stack,
  `toSeedPlan` → seed) — don't re-derive these facts elsewhere; **extend the
  model**. Pure TS, so Bun server and React client both use it.
- **The webapi is the sole I/O gateway** (stability column): consumers never touch
  CouchDB/S3 directly; writes are never proxied. The lone exception is host-side
  metadata ingestion (local files the container can't see).
- **OpenAPI spec is the contract source of truth**; the webui + cli consume
  clients **generated** from it (orval, `bun run gen:clients`). Don't hand-write
  request code.
- **Append-only / immutable docs.** New info is a new doc referencing `session_id`,
  never an in-place edit — this keeps future CouchDB replication conflict-free.
  Schema/view changes go through the self-built **migrations** (not ad-hoc scripts).
- **CouchDB doc schemas are defined in code** (shared types + validators) and
  validated at the webapi on write.
- `@claude-transcripts/shared` `sumTranscriptTokens` and the hook's copy (`hooks/`) must
  stay byte-identical (the hook can't resolve the workspace at install time).
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

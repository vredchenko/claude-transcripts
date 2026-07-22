# Dev automation

> **Status: planned (Tier 1).** This is **developer tooling**, kept **separate from
> the [CLI](cli.md)** (the CLI is a user/admin product; these are repo build/dev
> scripts). They live under `scripts/` and are run locally via `bun run` **and**
> wrapped as CI/CD jobs (`.github/workflows/`) so local and CI behaviour match.

## Pattern

Each automation is one script, runnable two ways:

```bash
bun run scripts/<name>          # locally
```

…and invoked by a thin CI workflow that calls the same script — one source of
truth for the behaviour, no drift between local and CI.

## Scripts (planned)

| Script | Does | Notes |
|--------|------|-------|
| **regenerate-api-clients** | Generate the typed API clients from the **latest OpenAPI spec** into **both** the CLI and the webui SPA | **orval**; the first one we build. [ADR 0019](decisions/0019-openapi-source-of-truth-generated-clients.md) |
| **regenerate-compatibility** | Regenerate `compatibility.json` from the external Claude Code source of truth | [compatibility.md](compatibility.md) |
| **mirror-images** | Pull the pinned third-party backing-service images and push them to the **GitHub Container Registry (GHCR)** | [ADR 0024](decisions/0024-mirror-backing-images-to-registry.md), [containers.md](containers.md) |
| **release** | Version all components together (semver) and build the combined image | [ADR 0023](decisions/0023-lockstep-versioning-and-combined-image.md) |
| **build-docs** | Render `docs/*.md` (+ `decisions/`) into a self-contained static HTML site | see below; feeds GitHub Pages `/docs` and the combined image |
| **migrate** *(via cli, not here)* | Schema/view migrations | lives in [cli/](tools.md), not `scripts/` |

## Client generation (orval)

The OpenAPI spec emitted by the webapi ([webapi.md](webapi.md)) is the contract
source of truth. `bun run gen:clients` (`regenerate-api-clients`) runs in two steps:

1. **Emit the spec offline** — `packages/webapi/src/write-openapi.ts` builds the
   OpenAPI document from the registered routes with **no server and no Couch/S3
   connections** (route registration doesn't touch the backends), writing the
   gitignored `openapi.json`. Deterministic, runnable anywhere — no live port.
2. **Run [orval](https://orval.dev)** over that spec (`orval.config.ts`) to emit:
   - the **CLI**'s client → `packages/cli/src/api/generated.ts` (fetch client; a
     hand-written **mutator**, `src/api/http.ts`, injects the off-origin base URL),
   - the **webui** SPA's client → `packages/webui/src/api/generated.ts` (react-query).

Both consumers share one generated, typed boundary and can't drift from the
contract ([ADR 0019](decisions/0019-openapi-source-of-truth-generated-clients.md)).
Route `operationId`s name the generated functions (e.g. `ingestSummary`). The
generated clients are **committed** (regenerated in CI and checked) so a contract
change fails fast at the consumer. The CLI's `WebapiSink` (used by `backfill`) calls
these functions; the raw transcript upload stays a direct mutator call (no JSON
schema for a binary body).

## Docs static build (build-docs)

`bun run build:docs` (`scripts/build-docs.ts`) renders the Markdown in `docs/`
(plus `docs/decisions/`) into a self-contained, theme-aware HTML site with a
sidebar, writing to `build/docs/` by default (`--out <dir>` to override). It is
**dependency-free** — Bun + Node built-ins only, with a small GFM-subset Markdown
renderer — so it needs no install (CI stays `--frozen-lockfile`) and its output is
fully offline. The same output is consumed twice: the [Pages workflow](../.github/workflows/pages.yml)
renders it into the published `/docs`, and the combined app image bakes it in to be
served by the webapi ([containers.md](containers.md)). The renderer is intentionally
minimal and swappable for a full SSG later.

## CI/CD wrapping

Every `scripts/*` script has a matching GitHub Actions job that runs it (lint
/ typecheck / build remain in `ci.yml`). Release jobs build the components and the
combined image ([containers.md](containers.md)).

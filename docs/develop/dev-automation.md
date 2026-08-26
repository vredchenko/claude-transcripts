# Dev automation

> **Status: planned (Tier 1).** This is **developer tooling**, kept **separate from
> the [CLI](../reference/cli.md)** (the CLI is a user/admin product; these are repo build/dev
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
| **regenerate-api-clients** | Generate the typed API clients from the **latest OpenAPI spec** into **both** the CLI and the webui SPA | **orval**; the first one we build. [ADR 0019](../design/decisions/0019-openapi-source-of-truth-generated-clients.md) |
| **regenerate-compatibility** | Regenerate `compatibility.json` from the external Claude Code source of truth | [compatibility.md](../start/compatibility.md) |
| **mirror-images** | Pull the pinned third-party backing-service images and push them to the **GitHub Container Registry (GHCR)** | [ADR 0024](../design/decisions/0024-mirror-backing-images-to-registry.md), [containers.md](../operate/containers.md) |
| **release** | Stamp one lockstep semver across every component manifest (`--check` verifies without writing); CI does the building on the tag | [ADR 0023](../design/decisions/0023-lockstep-versioning-and-combined-image.md), [releasing.md](../operate/releasing.md) |
| **gen-diagram** | Render the architecture diagram from the app model's topology into committed SVGs | see below; consumed by the README and [architecture.md](../design/architecture.md) |
| **build-docs** | Render `docs/*.md` (+ `decisions/`) into a self-contained static HTML site | see below; feeds GitHub Pages `/docs` and the combined image |
| **migrate** *(via cli, not here)* | Schema/view migrations | lives in [cli/](../operate/tools.md), not `scripts/` |

## Client generation (orval)

The OpenAPI spec emitted by the webapi ([webapi.md](../reference/webapi.md)) is the contract
source of truth. `bun run gen:clients` (`regenerate-api-clients`) runs in two steps:

1. **Emit the spec offline** — `packages/webapi/src/write-openapi.ts` builds the
   OpenAPI document from the registered routes with **no server and no Couch/S3
   connections** (route registration doesn't touch the backends), writing the
   gitignored `openapi.json`. Deterministic, runnable anywhere — no live port.
2. **Run [orval](https://orval.dev)** over that spec (`orval.config.ts`) to emit:
   - the **CLI**'s client → `packages/cli/src/api/generated.ts` (fetch client; a
     hand-written **mutator**, `src/api/http.ts`, injects the off-origin base URL),
   - the **webui** SPA's client → `packages/webui/src/api/generated.ts` (react-query
     over `fetch`; its own **mutator**, `src/api/http.ts`, unwraps responses and
     throws on non-2xx so react-query sees failures).
3. **Format the emitted files with Biome**, so generated code passes `lint` without
   anyone hand-editing it. Deterministic — regeneration is byte-identical.

Both clients are now **faithful orval output**: `bun run gen:clients` overwrites them
and nothing is hand-maintained. Getting there needed three things, worth knowing before
touching the config:

- **Named component schemas.** Response schemas are registered with
  `.openapi("Name")` in the route modules. Without a name the spec inlines a schema at
  each use site, and orval can only name the resulting type after the route it appeared
  in — `ListSessions200SessionsItemStatus` instead of `SessionStatus`. Naming is what
  makes generated output readable enough to consume directly.
- **`includeHttpResponseReturnType: false`.** Both mutators return the response body,
  so without this the generated types describe a `{data, status, headers}` envelope
  that has already been unwrapped, and every call site reads `.data.data`.
- **An `ErrorType` export from each mutator.** Orval otherwise types errors from the
  route's *error response schema* (`ApiError`), but callers catch what the mutator
  **throws**. Exporting `ErrorType` makes react-query's `error` an actual `Error`.

Both consumers share one typed boundary against the same OpenAPI contract
([ADR 0019](../design/decisions/0019-openapi-source-of-truth-generated-clients.md)).
Route `operationId`s name the generated functions (e.g. `ingestSummary`). The
generated clients are **committed** (regenerated in CI and checked) so a contract
change fails fast at the consumer. The CLI's `WebapiSink` (used by `backfill`) calls
these functions; the raw transcript upload stays a direct mutator call (no JSON
schema for a binary body).

## Architecture diagram (gen-diagram)

`bun run gen:diagram` (`scripts/gen-diagram.ts`) renders the architecture picture
from the app model, writing three committed SVGs under `docs/assets/`. It replaced
hand-typed ASCII that existed in five places, had drifted (`cli` in four of them,
`CLI` in the fifth), and — more importantly — was **wrong**: every copy routed the
hook *through* the webapi, when [ADR 0016](../design/decisions/0016-webapi-is-the-io-gateway.md#amendment-the-hook-is-a-second-writer)'s
amendment is precisely that the hook writes to CouchDB and S3 **directly**.

**The scene lives in the model**, not in the script:
[`packages/shared/src/model/topology.ts`](../../packages/shared/src/model/topology.ts)
declares the nodes and edges, and `toArchitectureDiagram()` in `model/project.ts`
projects them — filtered by detail level, with feature-gated nodes (and every edge
touching them) dropped. The generator owns only geometry. Node labels and ports are
read *through* `serviceKey`, so renaming a service in `services.ts` moves the diagram
too; `topology.test.ts` enforces that, along with `compact ⊆ expanded`.

Three outputs from one scene, because the two consumers cannot share a file:

| File | Consumer | Theming |
|------|----------|---------|
| `architecture-light.svg` / `architecture-dark.svg` | the README, behind `<picture>` | baked per file |
| `architecture.svg` | [architecture.md](../design/architecture.md), and so the docs site | `prefers-color-scheme` |

GitHub serves README SVGs through an image proxy in secure static mode, so
`<picture>` is the reliable way to switch themes there; a docs page can't use it at
all, because `build-docs` escapes raw HTML — hence the single theme-aware file. They
live under `docs/` because that is the only tree the Pages build copies: a link
escaping it is rewritten to a GitHub *blob HTML* URL and renders broken.

**Determinism matters more here than elsewhere.** CI regenerates and diffs, so the
generator reads `config.template.json` via `loadConfigTemplate` — never the gitignored
`config.json` — and passes an empty env to `buildAppModel`. Otherwise a contributor's
local port override or feature toggle would change the bytes and fail the drift gate
on their PR for a reason CI can't reproduce. (The other generators are immune by
accident: `gen-compose` emits `${VAR}` placeholders rather than resolved values.)

Third-party marks are inlined from [`brand/icons/`](../../brand/icons/README.md) —
an SVG in secure static mode cannot fetch anything external, so referencing them
would simply render nothing.

## Docs static build (build-docs)

`bun run build:docs` (`scripts/build-docs.ts`) renders the Markdown in `docs/`
(plus `docs/decisions/`) into a self-contained, theme-aware HTML site with a
sidebar, writing to `build/docs/` by default (`--out <dir>` to override). It is
**dependency-free** — Bun + Node built-ins only, with a small GFM-subset Markdown
renderer — so it needs no install (CI stays `--frozen-lockfile`) and its output is
fully offline. The same output is consumed twice: the [Pages workflow](../../.github/workflows/pages.yml)
renders it into the published `/docs`, and the combined app image bakes it in to be
served by the webapi ([containers.md](../operate/containers.md)). The renderer is intentionally
minimal and swappable for a full SSG later.

## CI/CD wrapping

Every `scripts/*` script has a matching GitHub Actions job that runs it (lint
/ typecheck / build remain in `ci.yml`). Release jobs build the components and the
combined image ([containers.md](../operate/containers.md)).

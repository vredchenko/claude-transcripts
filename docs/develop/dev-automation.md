# Dev automation

Repo build and dev scripts live in `scripts/`, run with `bun run scripts/<name>.ts` or
the `package.json` alias. They are not shipped to users; anything a user needs belongs
in the [CLI](../reference/cli.md).

## Generators

Generated files are committed. `bun run gen:all` runs every generator below except
`gen:clients`, and CI fails if either leaves a diff. Regenerate; never hand-edit.

| Alias | Script | Writes, from the app model unless noted |
|-------|--------|-----------------------------------------|
| `gen:clients` | `regenerate-api-clients.ts` | `openapi.json` + the orval clients in `packages/cli/src/api/` and `packages/webui/src/api/` |
| `gen:hooks` | `sync-hooks.ts` | `hooks/hooks/hooks.json` (events, timeouts, `async`) from `BINDINGS` |
| `gen:hook-events` | `gen-hook-events.ts` | [`docs/reference/hook-events.md`](../reference/hook-events.md) |
| `gen:diagram` | `gen-diagram.ts` | `docs/assets/architecture{,-light,-dark}.svg` |
| `gen:compose` | `gen-compose.ts` | `deploy/docker-compose.yml` |
| `gen:compose-override` | `gen-compose-override.ts` | `deploy/docker-compose.upstream.yml` (public upstream images) |
| `gen:k8s` | `gen-k8s.ts` | `deploy/k8s/base/` ([ADR 0030](../design/decisions/0030-kubernetes-deploy-generated-from-the-model.md)) |
| `gen:assets` | `gen-assets.ts` | `packages/cli/src/lib/assets.generated.ts`: compose files, `garage.toml` and the config template, embedded in the binary for `install` |
| `gen:cli-docs` | `gen-cli-docs.ts` | the command sections of `packages/cli/README.md` and [`docs/reference/cli.md`](../reference/cli.md), from `CLI_SPEC` |
| `gen:compat` | `regenerate-compatibility.ts` | `compatibility.json` (placeholder output, gitignored; [compatibility.md](../start/compatibility.md)) |
| `gen:mock` | `regenerate-mock-fixtures.ts` | synthetic content for the hook fixtures under `tests/mock/` (not in `gen:all`) |

Output must not depend on your local `config.json` or `.env`, or CI fails for a reason
it can't reproduce: `gen-diagram` reads `config.template.json` with an empty
environment, and `gen-compose` emits `${VAR}` placeholders rather than resolved values.

### API clients

`gen:clients` emits the spec offline (`packages/webapi/src/write-openapi.ts` registers
the routes without connecting to any store), runs [orval](https://orval.dev) over it
(`orval.config.ts`) and formats the output with Biome. Route `operationId`s name the
generated functions. Three settings make the output usable as is:

- Response schemas are registered with `.openapi("Name")`, so types are called
  `SessionStatus` rather than `ListSessions200SessionsItemStatus`.
- `includeHttpResponseReturnType: false`, because each client's mutator
  (`src/api/http.ts`) already unwraps the response body.
- Each mutator exports `ErrorType`, so callers' error types match what the mutator
  throws.

### Architecture diagram

The nodes and edges are declared in `packages/shared/src/blueprint/topology.ts`;
`gen-diagram.ts` only does layout. `architecture.svg` follows `prefers-color-scheme`
and is used by the docs; the README uses the light/dark pair inside `<picture>`,
because GitHub's image proxy needs that to switch themes. Third-party marks are inlined
from `brand/icons/`, since an SVG served this way can't fetch anything.

## Other scripts

| Alias | Script | Does | Where it runs |
|-------|--------|------|---------------|
| `build:docs` | `build-docs.ts` | Renders `docs/` into a static site (`build/docs/`, `--out <dir>`). Dependency-free, small GFM subset. Fails on a broken relative link. The section list lives in the script; pages within a section are picked up automatically. | CI, `pages.yml`, the app image (`/docs`) |
| `check:contract` | `check-contract.ts` | Fails on a breaking OpenAPI change ([testing.md](testing.md#contract)) | CI |
| — | `mirror-images.ts` | Copies the pinned backing-service images to GHCR ([ADR 0024](../design/decisions/0024-mirror-backing-images-to-registry.md)) | `mirror-images.yml` |
| — | `build-cli-npm.ts` | Bundles the CLI for npm | `release-cli.yml` |
| — | `release.ts` | Stamps one version into every manifest ([releasing.md](../operate/releasing.md)) | local |
| `stack:*` | `stack.ts` | `up`/`down`/`restart`/`logs`/`ps` for the dev stack; `--upstream`, `--build`, `--app` | local |
| `bootstrap:garage` | `bootstrap-garage.ts` | Garage layout, bucket and app key; writes the key into `.env` | local |
| `seed` | `seed.ts` | Creates missing CouchDB databases and reports buckets (`--dry-run`) | local |

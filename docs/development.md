# Development

Bun workspace monorepo. Work on a single primary branch, **`main`** — cut a
feature branch off `main`, open a PR, merge back into `main`
([branching.md](branching.md), [ADR 0026](decisions/0026-single-main-branch.md)).

In development the **backing services run via Docker Compose** (CouchDB + Garage +
Meilisearch + their admin UIs, on the dev port range `7650`–`7661`,
[containers.md](containers.md)) and the **webapi/webui/CLI run on the host** against
them. Repo build/dev automation lives in `scripts/`
([dev-automation.md](dev-automation.md)) — including `regenerate-api-clients`
(orval → CLI + SPA clients).

```bash
bun install
cp .env.example .env          # point at your CouchDB + S3
bun run dev:webapi            # http://127.0.0.1:7650
bun run dev:webui             # http://127.0.0.1:7651 (proxies /api → webapi)

bun run lint                  # biome check .
bun run typecheck
bun run build                 # build the webui SPA
```

Tooling: Bun, TypeScript (ESM, strict), Hono, React 19 + Vite + MUI, Biome
(lint/format), lefthook pre-commit.

## Repo layout

| Path | Purpose |
|------|---------|
| `hook/` | Claude Code session-logging plugin (Bun). `scripts/dispatch.ts` routes every hook event to handler modules in `scripts/handlers/`. Writes to CouchDB + S3. |
| `packages/shared/` | Shared types + token accounting. |
| `packages/webapi/` | Hono + Bun read API; serves the SPA in production. |
| `packages/webui/` | React + Vite + MUI SPA. |
| `deploy/` | docker-compose stack: app-only (external backends) or `--profile full` (CouchDB + Garage + Meilisearch + app). |
| `docs/` | Architecture, configuration, hook setup, decisions, roadmap. |
| `claude-transcripts.config.json` | Top-level non-secret config (names, feature flags) — see [configuration.md](configuration.md). |

## Releases

Tag-driven, on **GitHub Actions** (`.github/workflows/`). **All components are
versioned together (lockstep semver)**: a `vX.Y.Z` tag versions webapi + webui +
CLI + shared as one set ([ADR 0023](decisions/0023-lockstep-versioning-and-combined-image.md)).
Each component is **built separately** (webapi bundle, webui SPA, CLI binary) and
released, then **combined** into one image published to the **GitHub Container
Registry (GHCR)** (`publish-image.yml`) tagged `:vX.Y.Z`, `:latest`, and
`:<short-sha>`; image scans (grype + trivy) gate the push. Backing-service images
are mirrored to GHCR ([ADR 0024](decisions/0024-mirror-backing-images-to-registry.md)).
CI on `main` runs lint/typecheck/build (`ci.yml`) but does **not** build an image.
Versioning is semver, git tags authoritative. See [ADR 0012](decisions/0012-github-actions-and-ghcr-for-releases.md).

The image path is derived from `${{ github.repository }}` (e.g.
`ghcr.io/<owner>/claude-transcripts-app`), and auth uses the built-in
`GITHUB_TOKEN` — no custom registry host, user, or token secrets to configure.
`workflow_dispatch` can build a `:<sha>` image on demand.

```bash
git tag v0.1.0 -m "first standalone release"
git push origin v0.1.0
```

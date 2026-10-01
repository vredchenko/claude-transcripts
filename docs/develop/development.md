# Development

Bun workspace monorepo. Work on a single primary branch, **`main`** — cut a
feature branch off `main`, open a PR, merge back into `main`
([branching.md](branching.md), [ADR 0026](../design/decisions/0026-single-main-branch.md)).

In development the **backing services run via Docker Compose** (CouchDB + Garage +
Meilisearch + their admin UIs, on the dev port range `7650`–`7661`,
[containers.md](../operate/containers.md)) and the **webapi/webui/CLI run on the host** against
them. Repo build/dev automation lives in `scripts/`
([dev-automation.md](dev-automation.md)) — including `regenerate-api-clients`
(orval → CLI + SPA clients).

```bash
bun install
cp .env.template .env         # point at your CouchDB + S3
bun run dev:webapi            # http://127.0.0.1:7650
bun run dev:webui             # http://127.0.0.1:7651/app/ (proxies /api → webapi)

bun run lint                  # biome check .
bun run typecheck
bun run build                 # build the webui SPA
```

Tooling: Bun, TypeScript (ESM, strict), Hono, React 19 + Vite + MUI, Biome
(lint/format), lefthook pre-commit.

## Repo layout

See [getting-started.md](getting-started.md#how-the-pieces-fit).

## Releases

Tag-driven, on **GitHub Actions** (`.github/workflows/`). **All components are
versioned together (lockstep semver)**: a `vX.Y.Z` tag versions webapi + webui +
CLI + shared as one set ([ADR 0023](../design/decisions/0023-lockstep-versioning-and-combined-image.md)).
The components (webapi, webui SPA, docs, CLI) build in separate stages of one
multi-stage `Dockerfile` and are **combined** into one image published to the
**GitHub Container Registry (GHCR)** (`publish-image.yml`): a tag pushes `:vX.Y.Z`,
`:latest`, and `:<short-sha>`; every push to `main` pushes `:main` and `:<short-sha>`.
Image scans (grype + trivy) gate the push. The CLI binaries are released separately
(`release-cli.yml`). Backing-service images are mirrored to GHCR
([ADR 0024](../design/decisions/0024-mirror-backing-images-to-registry.md)).
Versioning is semver, git tags authoritative. See [ADR 0012](../design/decisions/0012-github-actions-and-ghcr-for-releases.md).

The image path is derived from `${{ github.repository }}` (e.g.
`ghcr.io/<owner>/claude-transcripts-app`), and auth uses the built-in
`GITHUB_TOKEN` — no custom registry host, user, or token secrets to configure.
`workflow_dispatch` can build a `:<sha>` image on demand.

```bash
git tag v0.1.0 -m "first standalone release"
git push origin v0.1.0
```

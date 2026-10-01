# 12. GitHub Actions + GHCR for releases

Date: 2026-06-07

## Status

Accepted. Pins the CI system + registry for the tag-driven release *model* of
[ADR 0005](0005-tag-driven-image-releases.md) (which is unchanged). Amended
2026-09-30 — see [Amendment](#amendment-five-workflows-and-main-publishes).

## Context

The release model ([ADR 0005](0005-tag-driven-image-releases.md)) is
tag-driven: pushing a `vX.Y.Z` tag builds and publishes the single combined image
(webapi + prebuilt webui SPA). This record pins **which CI system and registry**
carry that out.

The project ships as a public **GitHub** repository, so its CI and registry are
the ones GitHub provides — nothing external to provision, and images live next to
the source.

## Decision

- **Release CI runs on GitHub Actions** (`.github/workflows/`, `runs-on:
  ubuntu-latest`) and publishes the combined image to the **GitHub Container
  Registry (GHCR, `ghcr.io`)**.
- **The image path derives from the repo**: `ghcr.io/${{ github.repository }}-app`
  (lowercased), so it tracks `<owner>/<repo>` instead of being hardcoded.
- **Auth uses the built-in `GITHUB_TOKEN`** (`permissions: packages: write`) — no
  committed registry secrets. `docker/login-action` logs in to `ghcr.io` as
  `${{ github.actor }}`.
- Two workflows: `ci.yml` (lint/typecheck/build on push + PR to `main`) and
  `publish-image.yml` (tag-driven `v*.*.*` + `workflow_dispatch`, grype/trivy
  gated before push).

## Consequences

- No external CI/registry to configure — a clone or fork gets working CI and a
  place to publish images out of the box; the publisher only needs the repo's own
  `GITHUB_TOKEN` (granted by default).
- Because the path derives from `${{ github.repository }}`, **forks publish to
  their own GHCR namespace with no edits**.
- The release version is baked at build time via the `CT_VERSION` build arg and
  surfaced at `/health` + in the OpenAPI doc (unchanged from 0005).
- Backing-service images are mirrored to the same registry
  ([ADR 0024](0024-mirror-backing-images-to-registry.md)); a fresh clone can also
  skip the registry entirely with the upstream dev override
  ([containers.md](../../operate/containers.md)).

## Amendment: five workflows, and main publishes

*2026-09-30.*

The two workflows above are now five; `publish-image.yml` also runs on `main`
([why](0005-tag-driven-image-releases.md#amendment-main-publishes-too-and-versions-live-in-the-tree)):

| workflow | runs on | does |
|---|---|---|
| `ci.yml` | push + PR to `main` | lint/typecheck/test/build, generated-file and contract checks, the Bun-floor check, browser tests |
| `publish-image.yml` | `v*.*.*` tag, push to `main`, dispatch | the combined image ([tags](../../operate/releasing.md#app-image-tags)); grype/trivy before push |
| `release-cli.yml` | `v*.*.*` tag, dispatch | cross-compiled CLI binaries on the GitHub Release, and the npm package |
| `mirror-images.yml` | `v*.*.*` tag, dispatch | mirrors the backing-service images ([ADR 0024](0024-mirror-backing-images-to-registry.md)) |
| `pages.yml` | push to `main` (site/docs paths), dispatch | the project site and rendered docs on GitHub Pages |

`release-cli.yml` needs one optional secret, `NPM_TOKEN`; without it the npm step is
skipped with a warning.

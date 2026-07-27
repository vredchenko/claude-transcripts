# 5. Tag-driven image releases

Date: 2026-06-06

## Status

Accepted. The CI system + registry specifics are pinned by
[ADR 0012](0012-github-actions-and-ghcr-for-releases.md) (GitHub Actions + GHCR);
the tag-driven release *model* below stands.

## Context

The project ships as a public GitHub repository. Its release process should be
simple and reproducible: a version tag produces a versioned image, and ordinary
commits don't. This matches the tag-driven pattern the owner already operates
elsewhere (no per-commit image builds).

## Decision

- **Releases are tag-driven.** Pushing a `vMAJOR.MINOR.PATCH` tag builds the
  combined image and publishes it (`:vX.Y.Z`, `:latest`, `:<short-sha>`) with
  grype + trivy gates before push. A push/PR to `main` runs lint/typecheck/build
  (`ci.yml`) only — it does **not** build an image. Versioning is semver with git
  tags authoritative; no `version` field in `package.json`.
- The CI lives under `.github/workflows/` and publishes to GHCR — see
  [ADR 0012](0012-github-actions-and-ghcr-for-releases.md) for the CI/registry
  details.

## Consequences

- The release version is injected at build time via the `CT_VERSION` build arg
  and surfaced at `/health` and in the OpenAPI doc.
- No version tags are cut yet; the first release tag is a deliberate future step.
- Because ordinary commits don't build images, the registry only ever holds
  intentional, tagged releases (plus the `:<sha>` from a manual dispatch).

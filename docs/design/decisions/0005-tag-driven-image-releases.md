# 5. Tag-driven image releases

Date: 2026-06-06

## Status

Accepted. The CI system + registry specifics are pinned by
[ADR 0012](0012-github-actions-and-ghcr-for-releases.md) (GitHub Actions + GHCR);
the tag-driven release *model* below stands. Amended 2026-09-30 — see
[Amendment](#amendment-main-publishes-too-and-versions-live-in-the-tree).

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

## Amendment: main publishes too, and versions live in the tree

*2026-09-30.*

- `main` also publishes: `:main` + `:<sha>`, versioned `<last tag>+<sha>`; `:latest`
  still moves only on a release tag. Why: lockstep
  ([ADR 0023](0023-lockstep-versioning-and-combined-image.md)) needs an image tracking
  `main`.
- Manifests carry the lockstep `version`: `scripts/release.ts <ver>` stamps it into
  every manifest; `--check` verifies they match.
- Tags are cut (since `v0.0.1`). Details: [releasing.md](../../develop/releasing.md).

## Amendment: only tags publish, and the version is read from the tree

*2026-11-19* ([#289](https://github.com/vredchenko/claude-transcripts/issues/289)).
Supersedes the `:main` half of the amendment above.

- **No dev builds.** `main` still builds and scans the app image, but only a
  `v*.*.*` tag publishes (`:vX.Y.Z`, `:latest`, `:<sha>`). The `:main` image existed
  because releases were months apart; they are now cheap, so running unreleased code
  for real means cutting a patch release.
- **No `CT_VERSION`.** The version was injected as a build argument, which the omnibus
  image silently dropped (`COPY --from` carries files, not `ENV`): 0.10.2 reported
  `0.0.0-dev`. Every component now reads the lockstep version from `package.json`
  (`APP_VERSION` in `@claude-transcripts/shared`, bundled into the compiled CLI),
  reported as `vX.Y.Z`. The manifests are the one source; `release.ts --check` gates
  every tag against them, and the omnibus smoke test checks `/health` and the CLI.

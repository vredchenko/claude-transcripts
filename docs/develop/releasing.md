# Releasing

One `vX.Y.Z` tag versions everything together
([ADR 0023](../design/decisions/0023-lockstep-versioning-and-combined-image.md)); CI
does the building. Release notes go in [`CHANGELOG.md`](../../CHANGELOG.md).

## Cutting a release

```bash
bun run scripts/release.ts 0.4.0     # stamp the version everywhere (--check verifies)
git commit -am "chore(release): 0.4.0"   # on a branch, merged via PR
git tag v0.4.0 && git push origin v0.4.0 # from main, once merged
```

`release.ts` writes the version into the root and every `packages/*/package.json`,
`hooks/.claude-plugin/plugin.json` and `.claude-plugin/marketplace.json`, and re-runs
`gen:k8s` (the k8s base pins the app image to it) and `gen:helm` (the chart's version
and appVersion are the release). The tag is what CI acts on; the chart job refuses to
publish a chart whose version isn't the tag's.

## Choosing the version

[Semver](https://semver.org/spec/v2.0.0.html), decided by the kind of change, not its size:

- **Minor** (`0.7.0`): the release adds anything new, however small. If the changelog
  entry has an `### Added` section, it's a minor release.
- **Patch** (`0.7.1`): fixes only. Bug fixes, dependency and security bumps, docs.
- **Breaking changes** bump the minor version while the project is below 1.0, and get a
  `### Breaking` section in the changelog. From 1.0 on they bump the major version.

## What a tag publishes

| Artifact | Where | Workflow |
|----------|-------|----------|
| App image `claude-transcripts-app` (webapi + webui + docs + CLI) | `ghcr.io/<owner>/claude-transcripts-app` | [`publish-image.yml`](../../.github/workflows/publish-image.yml) |
| Omnibus image `claude-transcripts-omnibus` (the whole stack, one container) | `ghcr.io/<owner>/claude-transcripts-omnibus` | [`publish-image.yml`](../../.github/workflows/publish-image.yml) |
| Helm chart `claude-transcripts` | `oci://ghcr.io/<owner>/charts/claude-transcripts` | [`publish-image.yml`](../../.github/workflows/publish-image.yml) |
| Backing images: Garage mirrored (every platform upstream publishes); CouchDB, Meilisearch, the Garage web UI, the Meilisearch UI and Fossil built here. Each passes the scan gate before it is pushed | `ghcr.io/<owner>/claude-transcripts-*` | [`mirror-images.yml`](../../.github/workflows/mirror-images.yml) |
| CLI binaries (every target in `cli-targets.ts`: Linux glibc and musl, x64 and arm64, x64 baseline; macOS) + `.sha256` files | GitHub Release assets | [`release-cli.yml`](../../.github/workflows/release-cli.yml) |

The binaries embed the Bun runtime and need nothing else (the musl builds also want
`libstdc++` and `libgcc`). The target list lives in the blueprint
(`packages/shared/src/blueprint/cli-targets.ts`, [ADR 0036](../design/decisions/0036-cli-release-targets.md))
and is generated into the workflow, `install.sh`, the omnibus downloads and the install
docs. Before anything is published, every Linux binary is installed through
`install.sh` and run on its own platform (`scripts/smoke-cli-binary.sh`): on the x64
and arm64 runners, in Alpine for musl, and under QEMU with a pre-AVX2 CPU for baseline.
The macOS builds are cross-compiled and published without being run. There is no npm package
([ADR 0033](../design/decisions/0033-no-npm-package.md)): `install.sh` is the one-line
install, and a release needs no secrets.

What each artefact carries, platforms included, is in
[distributions.md](../reference/distributions.md).

`release-cli` and `mirror-images` can also be run by hand from the Actions tab; a
manual `release-cli` run builds and smoke-tests the binaries and uploads them as
workflow artifacts without publishing. `release-cli` also runs on a PR that touches the
workflow, `install.sh`, the smoke script or the target list.

### App image tags

The tags a release pushes (`vX.Y.Z`, `latest`, `<short-sha>`) are tabled where the
people pulling them look: [containers.md](../operate/containers.md#tags).

Only release tags publish. A push to `main` builds and scans the image the same way but
pushes nothing, so there is no image of unreleased code: to run it for real, cut a
patch release. Every build is scanned with grype and trivy and fails on HIGH severity,
so a base-image CVE can block a merge build too.

The version every component reports (`--version`, `/health`, the OpenAPI document, the
statusline, the omnibus downloads page) is read from the committed `package.json`;
nothing injects it at build time. On a tag, `publish-image` and `release-cli` run
`release.ts <version> --check` and fail if the tag disagrees with the manifests, every
smoke-tested binary's `--version` is checked against them, and the omnibus smoke test checks
`/health` and the bundled CLI.

### The scan gate

Every image the project publishes passes the same gate,
[`.github/actions/scan-image`](../../.github/actions/scan-image/action.yml): grype and
trivy, failing on HIGH or CRITICAL findings that have a fix. That covers the app image and
the omnibus (`publish-image.yml`) and each backing image (`mirror-images.yml`, which scans
an upstream image before copying it and a build before pushing it, so nothing that fails
reaches the registry under its tag). `scan-images.yml` re-runs the gate every Monday
against what is published, since pinned images pick up advisories between releases.

### Omnibus image tags

`claude-transcripts-omnibus` ([omnibus.md](../operate/omnibus.md)) is published on a release only:
`vX.Y.Z`, `latest` and `<short-sha>`, by the `omnibus` job in `publish-image.yml`. It is
assembled from the app image that workflow has just scanned and pushed, smoke-tested,
and held to the same scan gate. linux/amd64 only, like the app image. Pull requests that
touch it are built, smoke-tested and scanned by `omnibus.yml`, so a finding that would
stop the release shows up on a PR first. Because the gate also catches advisories
published since the last change, that check can go red on a PR that didn't cause it;
the fix is then a PR of its own.

## One-time setup

Images are pushed with the built-in `GITHUB_TOKEN`; no secret is needed.

1. After the first publish, make each GHCR package public (package page → Package
   settings → Change visibility), the `charts/claude-transcripts` chart included. Workflow permissions (Settings → Actions → General)
   must allow read/write.
2. Optionally, a protected `release` environment for a manual approval gate.

## Pulling from your own registry

To run the stack from your mirrored images rather than upstream registries, set
`IMAGE_NS=ghcr.io/<owner>` in `.env` and use `bun run stack:up` (not
`stack:up:upstream`).

Backing-image tags are pinned in two places that must agree: each service's
`defaultTag` in `packages/shared/src/blueprint/services.ts`, and the `*_TAG` lines in
`.env.template`. `mirror-images.ts` takes its list from the blueprint. Re-run
`mirror-images` (or tag a release) after bumping one.

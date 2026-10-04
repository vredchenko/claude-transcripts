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
`gen:k8s` (the k8s base pins the app image to it). The tag is what CI acts on.

## What a tag publishes

| Artifact | Where | Workflow |
|----------|-------|----------|
| App image `claude-transcripts-app` (webapi + webui + docs + CLI) | `ghcr.io/<owner>/claude-transcripts-app` | [`publish-image.yml`](../../.github/workflows/publish-image.yml) |
| Mirrored backing images (CouchDB, Garage, Meilisearch, admin UIs) | `ghcr.io/<owner>/claude-transcripts-*` | [`mirror-images.yml`](../../.github/workflows/mirror-images.yml) |
| CLI binaries (Linux and macOS, x64 and arm64) + `.sha256` files | GitHub Release assets | [`release-cli.yml`](../../.github/workflows/release-cli.yml) |
| `@claude-transcripts/cli` on npm (needs Bun at runtime) | npmjs.org | `release-cli.yml`, skipped with a warning until `NPM_TOKEN` is set |

The binaries embed the Bun runtime and need nothing else. The npm package is a bundle
with no runtime dependencies, for `bunx @claude-transcripts/cli`.

`release-cli` and `mirror-images` can also be run by hand from the Actions tab; a
manual `release-cli` run uploads the binaries as workflow artifacts without publishing.

### App image tags

| Tag | Means | Pushed by |
|-----|-------|-----------|
| `vX.Y.Z` | that release | a `v*.*.*` tag |
| `latest` | the newest release | a `v*.*.*` tag |
| `main` | the tip of `main` | every push to `main` |
| `<short-sha>` | one commit | all of the above, and manual dispatch |

`latest` tracks releases, not `main`. `install` pins the app image to the CLI's own
version, or to `main` for an unreleased CLI, and warns if the running app reports a
different version. Every build is scanned with grype and trivy and fails on HIGH
severity, so a base-image CVE can block a merge build too.

## One-time setup

Images are pushed with the built-in `GITHUB_TOKEN`; no secret is needed.

1. After the first publish, make each GHCR package public (package page → Package
   settings → Change visibility). Workflow permissions (Settings → Actions → General)
   must allow read/write.
2. For npm: create the `claude-transcripts` org on npmjs, create an Automation access
   token and store it as the repo secret `NPM_TOKEN`.
3. Optionally, a protected `release` environment for a manual approval gate.

## Pulling from your own registry

To run the stack from your mirrored images rather than upstream registries, set
`IMAGE_NS=ghcr.io/<owner>` in `.env` and use `bun run stack:up` (not
`stack:up:upstream`).

Backing-image tags are pinned in two places that must agree: each service's
`defaultTag` in `packages/shared/src/blueprint/services.ts`, and the `*_TAG` lines in
`.env.template`. `mirror-images.ts` takes its list from the blueprint. Re-run
`mirror-images` (or tag a release) after bumping one.

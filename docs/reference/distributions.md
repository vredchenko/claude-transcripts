# Distributions

Every way Claude Transcripts ships, and what each one carries. The webapi and
CouchDB are the core (Tier 1); everything else is optional, so a row without
Meilisearch or Garage is still a working install.

The app image is the one artefact with the app's own parts in it. The compose stack
and the Kubernetes base don't contain software; they run images, the app image among
them, and the table marks what they run. For how each is built and versioned, see
[releasing.md](../operate/releasing.md) and [containers.md](../operate/containers.md).

<!-- gen:distributions:start — generated from DISTRIBUTIONS by `bun run gen:distributions`; do not edit -->
| Distribution | webapi | webui | docs | CLI | plugin | CouchDB | Garage | Garage UI | Fossil | Meilisearch | Meili UI |
| --- | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: |
| App image | ● | ● | ● | ● |  |  |  |  |  |  |  |
| Compose stack | ○ | ○ | ○ | ○ |  | ● | ● | ● | ● | ● | ● |
| Kubernetes base (kustomize) | ● | ● | ● | ● |  | ● | ● | ● | ● | ● | ● |
| Mirrored backing images |  |  |  |  |  | ● | ● | ● |  | ● | ● |
| Backing images built from source |  |  |  |  |  |  |  |  | ● |  |  |
| CLI binaries |  |  |  | ● |  |  |  |  |  |  |  |
| npm package |  |  |  | ● |  |  |  |  |  |  |  |
| Claude Code plugin |  |  |  |  | ● |  |  |  |  |  |  |

● carried or run · ○ on request

| Distribution | Kind | Platforms | Published at | Built by |
| --- | --- | --- | --- | --- |
| App image | image | linux/amd64 | ghcr.io/&lt;owner&gt;/claude-transcripts-app | `Dockerfile`, `.github/workflows/publish-image.yml` |
| Compose stack | compose | whatever its images support | deploy/ in the repo; `install` writes it under ~/.local/share/claude-transcripts/deploy/ | `scripts/gen-compose.ts`, `scripts/gen-compose-override.ts`, `deploy/docker-compose.yml`, `deploy/docker-compose.upstream.yml` |
| Kubernetes base (kustomize) | kubernetes | whatever its images support | deploy/k8s/base/ in the repo | `scripts/gen-k8s.ts`, `deploy/k8s/base/kustomization.yaml` |
| Mirrored backing images | image | linux/amd64 (the runner's platform, pulled and re-pushed) | ghcr.io/&lt;owner&gt;/claude-transcripts-&lt;service&gt; | `scripts/mirror-images.ts`, `.github/workflows/mirror-images.yml` |
| Backing images built from source | image | linux/amd64 | ghcr.io/&lt;owner&gt;/claude-transcripts-&lt;service&gt; | `deploy/fossil/Dockerfile`, `scripts/mirror-images.ts`, `.github/workflows/mirror-images.yml` |
| CLI binaries | binary | linux-x64, linux-arm64, darwin-x64, darwin-arm64 | GitHub Releases, claude-transcripts-&lt;os&gt;-&lt;arch&gt; + .sha256 | `.github/workflows/release-cli.yml`, `install.sh` |
| npm package | npm | anywhere Bun runs | npm: @claude-transcripts/cli | `scripts/build-cli-npm.ts`, `.github/workflows/release-cli.yml` |
| Claude Code plugin | plugin | anywhere Claude Code runs; needs Bun and the CLI | this repo as a plugin marketplace (.claude-plugin/marketplace.json → hooks/) | `.claude-plugin/marketplace.json`, `hooks/` |

- **App image**: webapi serving the webui (/app), docs (/docs) and the CLI binary (/cli/download). Release tags, plus `main`.
- **Compose stack**: The app is the opt-in `app` profile. Pulls the mirror, or the public upstream images with --upstream (what `install` uses).
- **Kubernetes base (kustomize)**: `kubectl apply -k`; pinned upstream images, the app at the checkout's release tag. ClusterIP only: exposing it is an overlay's call.
- **Mirrored backing images**: Upstream images re-tagged under the project's names, so the stack can pull only from your registry (ADR 0024).
- **Backing images built from source**: For software that publishes no image. `--upstream` and `install` build it locally instead.
- **CLI binaries**: Self-contained (Bun runtime embedded). install.sh fetches and verifies one, then runs `install`.
- **npm package**: A bun-runnable bundle, no dependencies (`bunx @claude-transcripts/cli`). Needs Bun; the binaries don't.
- **Claude Code plugin**: A thin shim: every hook event goes to `claude-transcripts hook run`.
<!-- gen:distributions:end -->

The table is generated from `packages/shared/src/blueprint/distributions.ts`. A new way
of shipping the stack adds a row there; a test fails if a published image belongs to no
row, or a row names a file that doesn't exist.

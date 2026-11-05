# Distributions

Every way Claude Transcripts ships, and what each one carries. The webapi and
CouchDB are the core (Tier 1); everything else is optional, so a row without
Meilisearch or Garage is still a working install.

The app image and the omnibus image are the artefacts with the app's own parts in
them; the omnibus also carries every backing service, in one container. The compose
stack, the Kubernetes base and the Helm chart don't contain software; they run images,
the app image among them, and the table marks what they run. For how each is built and versioned, see
[releasing.md](../operate/releasing.md) and [containers.md](../operate/containers.md).

<!-- gen:distributions:start — generated from DISTRIBUTIONS by `bun run gen:distributions`; do not edit -->
| Distribution | webapi | webui | docs | CLI | plugin | CouchDB | Garage | Garage UI | Fossil | Meilisearch | Meili UI |
| --- | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: |
| App image | ● | ● | ● | ● |  |  |  |  |  |  |  |
| Omnibus image | ● | ● | ● | ● | ● | ● | ● | ● | ● | ● | ● |
| Compose stack | ○ | ○ | ○ | ○ |  | ● | ● | ● | ● | ● | ● |
| Kubernetes base (kustomize) | ● | ● | ● | ● |  | ● | ● | ● | ● | ● | ● |
| Helm chart | ● | ● | ● | ● |  | ● | ● | ● | ● | ● | ● |
| Mirrored backing images |  |  |  |  |  |  | ● |  |  | ● | ● |
| Backing images built from source |  |  |  |  |  | ● |  | ● | ● |  |  |
| CLI binaries |  |  |  | ● |  |  |  |  |  |  |  |
| npm package |  |  |  | ● |  |  |  |  |  |  |  |
| Claude Code plugin |  |  |  |  | ● |  |  |  |  |  |  |

● carried or run · ○ on request

| Distribution | Kind | Platforms | Published at | Built by |
| --- | --- | --- | --- | --- |
| App image | image | linux/amd64 | ghcr.io/&lt;owner&gt;/claude-transcripts-app | `Dockerfile`, `.github/workflows/publish-image.yml` |
| Omnibus image | image | linux/amd64 | ghcr.io/&lt;owner&gt;/claude-transcripts-omnibus | `deploy/omnibus/Dockerfile`, `deploy/omnibus/docker-bake.hcl`, `.github/workflows/omnibus.yml`, `.github/workflows/publish-image.yml` |
| Compose stack | compose | whatever its images support | deploy/ in the repo; `install` writes it under ~/.local/share/claude-transcripts/deploy/ | `scripts/gen-compose.ts`, `scripts/gen-compose-override.ts`, `deploy/docker-compose.yml`, `deploy/docker-compose.upstream.yml` |
| Kubernetes base (kustomize) | kubernetes | whatever its images support | deploy/k8s/base/ in the repo | `scripts/gen-k8s.ts`, `deploy/k8s/base/kustomization.yaml` |
| Helm chart | kubernetes | whatever its images support | oci://ghcr.io/&lt;owner&gt;/charts/claude-transcripts | `scripts/gen-helm.ts`, `deploy/helm/claude-transcripts/Chart.yaml`, `.github/workflows/chart.yml`, `.github/workflows/publish-image.yml` |
| Mirrored backing images | image | every platform upstream publishes (the multi-arch index is copied as is) | ghcr.io/&lt;owner&gt;/claude-transcripts-&lt;service&gt; | `scripts/mirror-images.ts`, `.github/workflows/mirror-images.yml` |
| Backing images built from source | image | linux/amd64 | ghcr.io/&lt;owner&gt;/claude-transcripts-&lt;service&gt; | `deploy/couchdb/Dockerfile`, `deploy/fossil/Dockerfile`, `deploy/garage-ui/Dockerfile`, `scripts/mirror-images.ts`, `.github/workflows/mirror-images.yml` |
| CLI binaries | binary | linux-x64, linux-arm64, darwin-x64, darwin-arm64 | GitHub Releases, claude-transcripts-&lt;os&gt;-&lt;arch&gt; + .sha256 | `.github/workflows/release-cli.yml`, `install.sh` |
| npm package | npm | anywhere Bun runs | npm: @claude-transcripts/cli | `scripts/build-cli-npm.ts`, `.github/workflows/release-cli.yml` |
| Claude Code plugin | plugin | anywhere Claude Code runs; needs Bun and the CLI | this repo as a plugin marketplace (.claude-plugin/marketplace.json → hooks/) | `.claude-plugin/marketplace.json`, `hooks/` |

- **App image**: webapi serving the webui (/app), docs (/docs) and the CLI binary (/cli/download). Release tags, plus `main`.
- **Omnibus image**: The whole stack in one container under s6-overlay: one `docker run`, one /data volume, one published port (7650). Assembled from the released app image. Release tags only.
- **Compose stack**: The app is the opt-in `app` profile. Pulls the mirror, or the public upstream images with --upstream (what `install` uses).
- **Kubernetes base (kustomize)**: `kubectl apply -k`; pinned upstream images, the app at the checkout's release tag. ClusterIP only: exposing it is an overlay's call.
- **Helm chart**: `helm install`, Argo CD or Flux. Generated from the same objects as the kustomize base; pulls every image from the project's registry, generates secrets on install and keeps them on upgrade, and provisions Garage with a hook Job. Release tags only.
- **Mirrored backing images**: Upstream images copied under the project's names, so the stack can pull only from your registry (ADR 0024).
- **Backing images built from source**: For software that publishes no image (Fossil), or whose image fails the scan gate: CouchDB without its unused Nouveau service, and the Garage web UI rebuilt from the same release with a current Go. `--upstream` and `install` build Fossil locally and pull the other two from upstream.
- **CLI binaries**: Self-contained (Bun runtime embedded). install.sh fetches and verifies one, then runs `install`.
- **npm package**: A bun-runnable bundle, no dependencies (`bunx @claude-transcripts/cli`). Needs Bun; the binaries don't.
- **Claude Code plugin**: A thin shim: every hook event goes to `claude-transcripts hook run`.
<!-- gen:distributions:end -->

The table is generated from `packages/shared/src/blueprint/distributions.ts`. A new way
of shipping the stack adds a row there; a test fails if a published image belongs to no
row, or a row names a file that doesn't exist.

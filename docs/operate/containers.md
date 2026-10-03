# Containers

## The app image

`claude-transcripts-app` serves everything under one origin
([ADR 0002](../design/decisions/0002-single-combined-container.md),
[routes.md](../reference/routes.md)): the webapi, the webui at `/app`, the Scalar API
reference at `/api/docs`, these docs at `/docs`, and the CLI binary at `/cli/download`
(also on the container's `PATH`).

- Built from source by one multi-stage `Dockerfile` on `oven/bun:1`: the webui, the
  docs (`build:docs`) and the compiled CLI each build in their own stage and are
  copied into the runtime stage.
- Carries `config/` with the committed template. Mount `/app/config/config.json` to
  override it. Secrets and backend endpoints come from the environment at run time.
- Listens on 7650 inside the container. Published by `publish-image.yml`
  ([releasing.md](releasing.md#app-image-tags)).

## One Compose stack, two uses

`deploy/docker-compose.yml` is generated from the app model (`bun run gen:compose`).
It holds CouchDB, Garage, Fossil, Meilisearch and their admin UIs (Fauxton, Garage web
UI, Meilisearch UI; Fossil is its own web UI), plus the app under the `app` profile. Everything binds to
`127.0.0.1`.

- **Development** — backing services only (`bun run stack:up:upstream`); the webapi,
  webui and CLI run on the host. Data is bind-mounted under `deploy/data/`.
- **Deployment** — the same stack with the app container added
  (`bun run scripts/stack.ts up --app`, or `install`, which writes the compose files
  under `~/.local/share/claude-transcripts/deploy/`).

Images: the base file pulls from `${IMAGE_NS}`, your mirror in GHCR
([ADR 0024](../design/decisions/0024-mirror-backing-images-to-registry.md));
`docker-compose.upstream.yml` (`--upstream`, and what `install` uses) swaps in the
public upstream images — and builds Fossil, which publishes none, from
`deploy/fossil/Dockerfile`; `docker-compose.build.yml` (`--build`) builds the app from
the checkout.

## Other topologies

- **Kubernetes** — the same stack as a generated kustomize base in `deploy/k8s/`
  ([README](../../deploy/k8s/README.md),
  [ADR 0030](../design/decisions/0030-kubernetes-deploy-generated-from-the-model.md)),
  for a single-node k3s or any cluster with a default StorageClass.
- **External backends** — run the app container alone with its environment pointing
  at your own CouchDB, S3 and Meilisearch
  ([configuration.md](../start/configuration.md#backend-topology--bundled-or-external)).

Planned, not built: maintained base images (pinned Bun runtime, a Claude Code runtime,
our own builds of the backing services). Fossil is the one backing service already
built here, because it has no upstream image
([ADR 0031](../design/decisions/0031-fossil-as-bundled-infrastructure.md)).

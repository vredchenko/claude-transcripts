# Containers & images

How the project is packaged. Two themes: the **single combined application
image** (what you deploy) and a planned set of **base images** we maintain and
build everything else from.

## The combined application image

One container serves the whole front door — webapi + the built webui SPA +
Swagger, and (Tier 3) the static HTML docs — under one origin
([ADR 0002](decisions/0002-single-combined-container.md),
[routes.md](routes.md)). It also **bundles the CLI binary**, which the webui
offers as a download link ([cli.md](cli.md)).

- **Runtime:** Bun. Built from our Bun base image (below).
- **Config:** the image carries `claude-transcripts.config.json` (non-secret defaults); secrets
  and **backend endpoints** come from env at run time — so the same image runs
  against the bundled Compose stack **or** fully external backends (external
  CouchDB, Cloudflare R2, remote Meilisearch). See
  [configuration.md](configuration.md).
- **Releases:** tag-driven on GitHub Actions to the GitHub Container Registry
  (GHCR) ([ADR 0012](decisions/0012-github-actions-and-ghcr-for-releases.md)).

## Deployment topologies

The app container needs only to know *where* its backends are:

- **Bundled** — Docker Compose brings up CouchDB + Garage (S3) + Meilisearch + the
  app, all local to the stack (Tier 1 default). The backing-service **admin UIs**
  (Fauxton, Garage WebUI, Meilisearch) are bundled too and linked from the webui
  Services menu.
- **External** — run the app container alone, pointing its env at remote services
  (e.g. managed CouchDB + Cloudflare R2 + a hosted search). Nothing in the image
  assumes localhost.

## Dev stack vs deployment stack

There is **one** `deploy/` Docker Compose definition, used two ways:

- **Development** — Compose brings up only the **backing services**: CouchDB,
  Garage, Meilisearch, **plus their admin web UIs** (Fauxton, Garage WebUI,
  Meilisearch UI), on the reserved local **dev port range `7650`–`7661`** (see
  [`CLAUDE.md`](../CLAUDE.md), no-auth, localhost-only). The **webapi, webui, and
  CLI run on the host** (`bun run dev:*`) against those Compose services. Fast
  iteration: edit code on the host, no image rebuild.
- **Deployment** — the **combined app image** we build from our own code
  ([ADR 0002](decisions/0002-single-combined-container.md)) is **added to the same
  Compose stack** as another service, alongside the backing services. Same stack,
  now self-contained.

So the only difference between dev and deploy is *where the app runs* — on the host
(dev) or as a container in the stack (deploy); the backing services are the same
Compose services either way.

## Build & release

Components are **built separately, then combined** into the deployment image, and
**versioned together** (lockstep semver) —
[ADR 0023](decisions/0023-lockstep-versioning-and-combined-image.md):

1. Build each component independently: webapi bundle, webui SPA `dist/`, CLI
   binary.
2. Release those artifacts.
3. **Combine** them into the single app image (serves `/api`, `/app`, Swagger,
   the bundled CLI download, and — Tier 3 — static docs).

Driven by `scripts` + CI ([dev-automation.md](dev-automation.md)).

## Mirrored backing images

All third-party backing-service images (CouchDB, Garage, Meilisearch + admin UIs)
are **mirrored into the GitHub Container Registry (GHCR)** and referenced from
there, pinned — [ADR 0024](decisions/0024-mirror-backing-images-to-registry.md). The
bundled stack uses the mirrored images by default so the whole system is
reproducible from a registry we control.

## Base images (planned)

> **Status: plan / future scope.** We intend to maintain a small family of base
> images and build the rest from them, so versions are pinned and reproducible.

| Image | Purpose |
|-------|---------|
| **Bun runtime** | Pinned Bun + toolchain; base for the app image and CLI builds. |
| **Claude Code runtime** | Bun base with Claude Code pre-installed — for running/automating agent sessions in-container. |
| **CLI utils** | A container full of the operational CLIs ([tools.md](tools.md), [cli.md](cli.md)). |
| **OpenHack** | The OpenHack cybersec toolset bundled for security workflows (future, see below). |
| **Fossil / SCM / code-search util** | Optional Fossil (or git-like) + source-code search utility container (future). |
| **CouchDB / Meilisearch / Garage** | Our own pinned builds of the backing services, so the stack is fully self-maintained. |

## Future: extensibility & bundled tooling (Tier 3)

Beyond the core, the roadmap envisions bundling additional capability and exposing
**our own integration points** so third parties can extend the system:

- Bundle the **OpenHack** cybersec repo with the project.
- Optionally a **Fossil** (or git-like) layer for additional coding/versioning
  functionality, and a source-code search utility.
- Define and document **extension/integration points** (e.g. action plugins,
  webapi extension routes) — placeholder; to be specified.

These are explicitly Tier-3 / future scope ([tiers.md](tiers.md)) — listed here so
the image strategy accounts for them, not committed for Tier 1.

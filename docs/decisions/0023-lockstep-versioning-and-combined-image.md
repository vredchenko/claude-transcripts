# 23. Lockstep versioning; components built separately, then combined into one image

Date: 2026-06-18

## Status

Accepted

## Context

The system has several custom components — **webapi**, **webui**, and the **CLI**
— plus a shared layer. They're developed in one monorepo but have different build
outputs (a server, a static SPA, a CLI binary). We need a coherent release story:
how they're versioned, and how they're packaged.

## Decision

- **Semantic versioning, all parts versioned together (lockstep).** Per the
  existing convention ([ADR 0005](0005-tag-driven-image-releases.md),
  [ADR 0012](0012-github-actions-and-ghcr-for-releases.md)), a single semver
  `vX.Y.Z` tag versions the **whole app** — webapi, webui, CLI, shared — as one
  unit. There are no independently-versioned components; a release is the set.
- **Build components separately, then combine.** Each component is **built
  independently** (webapi bundle, webui SPA `dist/`, CLI binary) and **released**,
  then a final step **combines them into one Docker image** (the combined
  container that serves `/api`, `/app`, Swagger, bundled CLI download, and — Tier 3
  — static docs; [ADR 0002](0002-single-combined-container.md), [containers.md](../containers.md)).

## Consequences

- One tag → one coordinated release; no version-skew between webapi and the
  clients (the OpenAPI-generated clients are regenerated at that version,
  [ADR 0019](0019-openapi-source-of-truth-generated-clients.md)).
- The build pipeline has two phases: **(1)** build + release each component,
  **(2)** assemble the combined image from those artifacts. The combine step is
  the only place the pieces meet.
- The CLI ships **both** as a released artifact (eventually per-OS binaries,
  [cli.md](../cli.md)) **and** bundled inside the image for the webui download
  link.
- Tag-driven releases run on GitHub Actions ([ADR 0012](0012-github-actions-and-ghcr-for-releases.md)).

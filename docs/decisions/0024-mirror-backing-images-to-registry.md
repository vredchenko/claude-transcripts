# 24. Mirror third-party backing-service images to the container registry

Date: 2026-06-18

## Status

Accepted

## Context

The bundled stack ([containers.md](../containers.md)) runs third-party backing
services — **CouchDB, Garage, Meilisearch** (and their admin UIs). Pulling these
from their upstream registries at deploy time means the project's reproducibility
depends on external registries staying available, unchanged, and rate-limit-free.

## Decision

Keep **copies of all third-party backing-service images** we depend on, **mirrored
in the project's own GitHub Container Registry (GHCR) namespace**. The bundled
stack and the release pipeline reference the **mirrored** images (pinned by
tag/digest), not the upstream ones directly. A dev automation
(`scripts/mirror-images`, [dev-automation.md](../dev-automation.md)) pulls the
pinned upstream images and pushes them to `ghcr.io/<owner>/…`.

For local development, a fresh clone can bypass the mirror entirely with the
**upstream dev override** (`bun run stack:up:upstream`), which pulls the canonical
public images directly — so the mirror is a **deploy/reproducibility** aid, not a
prerequisite for `git clone && run`.

## Consequences

- Deploys are reproducible from one registry we control — no hard runtime
  dependency on Docker Hub / upstream availability or rate limits.
- Images are **pinned** (tag + ideally digest); upgrades are deliberate (re-mirror
  a new pin), not implicit.
- The mirror is **optional for dev** (upstream override) and **required for a
  fully self-contained deploy**.

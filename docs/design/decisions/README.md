# Architecture Decision Records

Lightweight records of non-obvious decisions. See
[0001](0001-record-architecture-decisions.md) for the format and what counts.

| # | Title | Status |
|---|-------|--------|
| [0001](0001-record-architecture-decisions.md) | Record architecture decisions | Accepted |
| [0002](0002-single-combined-container.md) | Single combined container serves the API and the SPA | Accepted |
| [0003](0003-vendor-neutral-s3-drop-minio-and-rclone.md) | Vendor-neutral S3 via Bun's S3 client; drop MinIO and rclone | Accepted |
| [0004](0004-bun-monorepo-hook-as-standalone-plugin.md) | Bun workspace monorepo; the hook ships as a standalone plugin | Accepted |
| [0005](0005-tag-driven-image-releases.md) | Tag-driven image releases | Accepted (CI/registry specifics in 0012) |
| [0006](0006-no-openapi-client-codegen-shared-types.md) | Webui consumes shared workspace types directly; no OpenAPI client codegen | Superseded by 0019 |
| [0007](0007-couchdb-primary-store.md) | CouchDB as the primary store | Accepted |
| [0008](0008-garage-s3-object-store.md) | Garage as the S3 object store | Accepted |
| [0009](0009-meilisearch-search.md) | Meilisearch for search (Phase 2) | Proposed |
| [0010](0010-claude-code-specific-scope.md) | Claude-Code-specific scope (not a generic agent-session logger) | Accepted |
| [0011](0011-read-couch-attachments-over-http.md) | Read CouchDB attachments over HTTP, not nano's `attachment.get` | Superseded by 0014 |
| [0012](0012-github-actions-and-ghcr-for-releases.md) | GitHub Actions + GHCR for releases (pins CI/registry for 0005) | Accepted |
| [0013](0013-s3-is-the-transcript-home-couch-attachment-opt-in.md) | S3 is the transcript's home; the CouchDB attachment is opt-in (supersedes parts of 0011) | Superseded by 0014 |
| [0014](0014-transcripts-live-in-s3-only.md) | Transcripts live in S3 only — CouchDB attachment support removed (supersedes 0013) | Accepted |
| [0015](0015-tiered-architecture.md) | Tiered architecture (Tier 1 / 2 / 3) | Accepted |
| [0016](0016-webapi-is-the-io-gateway.md) | The webapi is the sole I/O gateway and stability column | Accepted |
| [0017](0017-hooks-and-actions-decoupled.md) | Hooks and actions are decoupled (many-to-many) | Accepted |
| [0018](0018-app-logging-into-couchdb.md) | Application/operational logs go to CouchDB (separate database) | Accepted |
| [0019](0019-openapi-source-of-truth-generated-clients.md) | OpenAPI spec is the source of truth; clients are generated (supersedes 0006) | Accepted |
| [0020](0020-bundled-services-default-no-auth.md) | Bundled backing services default to no auth | Accepted |
| [0021](0021-self-built-couchdb-migrations.md) | Self-built CouchDB migrations (up/down + views + import/export) | Accepted |
| [0022](0022-root-route-is-a-machine-readable-manifest.md) | `/` serves a machine-readable app manifest (agent entrypoint) | Accepted |
| [0023](0023-lockstep-versioning-and-combined-image.md) | Lockstep versioning; components built separately, then combined into one image | Accepted |
| [0024](0024-mirror-backing-images-to-registry.md) | Mirror third-party backing-service images to the container registry | Accepted |
| [0025](0025-claude-code-compatibility-matrix.md) | Claude Code compatibility is a generated, structured definition | Accepted |
| [0026](0026-single-main-branch.md) | A single `main` branch | Accepted |
| [0027](0027-full-content-chunks-in-couchdb.md) | Full-content chunks in CouchDB (per-turn content, not just byte ranges) | Accepted (write path done) |

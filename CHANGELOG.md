# Changelog

All notable changes to **Claude Transcripts** are recorded here. Every component is
**lockstep-versioned** — one `vMAJOR.MINOR.PATCH` tag versions the hook, webapi,
webui, CLI, and shared layer as a set ([ADR 0023](docs/design/decisions/0023-lockstep-versioning-and-combined-image.md)).
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning
is [semver](https://semver.org/spec/v2.0.0.html).

## [0.0.1] — 2026-07-29

First tagged release: the **Tier 1** system — single machine, single user, no auth —
end to end. It captures sessions, stores them, and serves them back over an HTTP
gateway, a web UI, and a CLI. Treat it as an early preview: the pieces work
together, but the surface is still moving.

### Added

**Capture (the hook)**

- Claude Code writer plugin (`hooks/`) covering the session-activity events, posting
  each event to the webapi as it happens and uploading the summary + byte-faithful
  transcript at session end. Never blocks a session — every external call is
  wrapped.
- **Full-content chunks**: parsed per-turn entries embedded in CouchDB chunk docs
  ([ADR 0027](docs/design/decisions/0027-full-content-chunks-in-couchdb.md)), which
  is what makes content search and the speaker views possible.
- Synthetic hook fixtures plus a regenerator, and an end-to-end test harness.

**Store**

- CouchDB as the primary store ([ADR 0007](docs/design/decisions/0007-couchdb-primary-store.md)),
  append-only/immutable docs, schemas defined in code and validated on write.
- Self-built **migration engine** for schema and view changes
  ([ADR 0021](docs/design/decisions/0021-self-built-couchdb-migrations.md)).
- S3 (Garage) as the transcript home ([ADR 0014](docs/design/decisions/0014-transcripts-live-in-s3-only.md));
  transcripts are not CouchDB attachments.
- **Meilisearch** full-text search over session metadata *and* conversation content,
  returning snippet hits.

**Serve (webapi)**

- Bun + Hono + zod-openapi gateway — the sole I/O path
  ([ADR 0016](docs/design/decisions/0016-webapi-is-the-io-gateway.md)) — with Scalar
  API docs at `/api/docs` and the OpenAPI spec as the contract source of truth
  ([ADR 0019](docs/design/decisions/0019-openapi-source-of-truth-generated-clients.md)).
- The root route is a machine-readable manifest projected from the app model
  ([ADR 0022](docs/design/decisions/0022-root-route-is-a-machine-readable-manifest.md)).
- Read-only `/api/couch` + `/api/s3` proxies; `/api/search`; per-session and
  cross-session turn endpoints (`/api/sessions/{id}/turns`, `/api/turns`).
- `/health` reports **store readiness** and identifies the server.
- Configurable live-session window (default 24h); accepts a full `COUCHDB_URL`
  (HTTPS and path prefixes included).
- App logging into CouchDB ([ADR 0018](docs/design/decisions/0018-app-logging-into-couchdb.md)).

**Read (webui + CLI)**

- React + Vite + MUI session browser: duration/path/source columns, services menu,
  light/dark themes, thin header with search, and a per-session speaker toggle
  (You/Claude).
- Active-vs-wall-clock session duration (idle-gap aware).
- Bun + Ink CLI with `setup`, `backfill` (adopt on-disk transcripts), `migrate`,
  `doctor` (now reporting store readiness and server identity), and `sessions`;
  bundled into the app image and offered as a download. Export/import and reconcile
  are registered as future commands, not yet implemented.

**Model + config**

- The **app model** in `@claude-transcripts/shared` as central state, built once from
  config + env, with consumers projecting from it (manifest, compose env, seed plan).
- Non-secret deployment config under `config/` (template committed, live instance
  gitignored, template as the zero-config dev fallback); `.env` holds only secrets
  and endpoints.
- Claude Code compatibility matrix generated from the upstream source of truth
  ([ADR 0025](docs/design/decisions/0025-claude-code-compatibility-matrix.md)).

**Deploy + release**

- Docker Compose stack (CouchDB + Garage + Meilisearch + admin UIs) with a local
  app-image build path (`stack --build`) and a Garage bootstrap script; bundled
  services default to no auth on localhost
  ([ADR 0020](docs/design/decisions/0020-bundled-services-default-no-auth.md)).
- Layered multi-stage image build serving the SPA, the API, and the docs at `/docs`.
- Tag-driven CI/CD: combined app image to GHCR (grype + trivy gated), backing images
  mirrored into the same registry
  ([ADR 0024](docs/design/decisions/0024-mirror-backing-images-to-registry.md)),
  cross-compiled CLI binaries (Linux + macOS, x64 + arm64) with SHA-256 sums attached
  to the GitHub Release, and an npm bundle.
- `scripts/release.ts` stamps the lockstep version across every manifest (`--check`
  to verify).
- Public landing page + technical docs published to GitHub Pages.

### Fixed

Found by dry-running the three tag-triggered workflows before cutting the tag — none
of them had ever executed:

- **Image mirroring pulled a nonexistent image.** `scripts/mirror-images.ts` kept its
  own hardcoded copy of the image list, in which the Meilisearch UI was
  `riccox/meilisearch-ui` — the account is `riccoxie`. The app model had it right all
  along, so the script now projects the list from the model (`toMirrorPlan`) and the
  two can no longer drift. The UI image is also pinned (`v0.14.1`) like every other
  backing image instead of floating on `latest`.
- **The published image carried the whole dev toolchain.** The runtime stage copied
  the full `node_modules`, so vite/esbuild/biome/orval and their vulnerabilities
  shipped to users and tripped the release's own HIGH-severity gate. The runtime now
  installs production dependencies only, and patches the base image's OS packages —
  the published base lags behind Debian security updates between rebuilds.

### Known limitations

- **Tier 1 scope**: no authentication or authorization anywhere — run it on
  localhost or a private network only.
- The npm publish of `@claude-transcripts/cli` is **skipped** until an `NPM_TOKEN`
  secret is configured; the compiled binaries and the images publish regardless.
  See [docs/operate/releasing.md](docs/operate/releasing.md).
- GHCR packages start **private** — flip each to public once after the first
  publish if you want unauthenticated `docker pull`.

[0.0.1]: https://github.com/vredchenko/claude-transcripts/releases/tag/v0.0.1

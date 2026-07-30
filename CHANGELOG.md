# Changelog

All notable changes to **Claude Transcripts** are recorded here. Every component is
**lockstep-versioned** — one `vMAJOR.MINOR.PATCH` tag versions the hook, webapi,
webui, CLI, and shared layer as a set ([ADR 0023](docs/design/decisions/0023-lockstep-versioning-and-combined-image.md)).
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning
is [semver](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- **BREAKING — `GET /api/sessions/{id}/transcript` now returns
  `{ entries, totalCount, hasMore, source, byteCoverage }`**; the `messages` array of
  raw Claude Code JSONL is gone. Chunk docs store pruned per-turn entries rather than
  raw bytes, so reading them first is necessarily a fidelity change; both sources
  normalise through `buildChunkEntries`, so the shape never varies with `source`.
  Byte-exact JSONL stays available via the read-only S3 proxy
  (`/api/s3/sessions/<id>/transcript.jsonl`). This narrows
  [ADR 0014](docs/design/decisions/0014-transcripts-live-in-s3-only.md): S3 is still
  the durable home, but no longer the read path.

### Added

- **Live search indexing via a CouchDB `_changes` follower.** The webapi follows the
  change feed and indexes `summary` / full-content `chunk` docs as they land, so a
  session recorded by the hook — which writes straight to CouchDB, not through the
  ingest endpoints — becomes searchable while it runs, with no manual step. Resumable
  (a checkpoint doc stores the sequence) and best-effort, so an indexing failure can
  never take down the webapi or block a write. Upserts only: deletes and pre-search
  history are still reconciled by `reindex`.
- **[ADR 0028](docs/design/decisions/0028-external-vs-bundled-meilisearch.md)
  (open/undecided)** — records why Meilisearch is harder to run externally than
  CouchDB or Garage: it isn't a store you point a URL at but a derived index we
  configure, feed, name and destructively rebuild. Options laid out; decision
  deliberately deferred.

- **`reindex`** (CLI) / `POST /api/search/reindex` — rebuild both Meilisearch indexes
  from CouchDB. The indexes are derived state written only as a side effect of
  `/api/ingest/*`, so nothing previously reconciled them: history adopted before search
  existed, anything written straight to CouchDB (the hook's path), and entries orphaned
  by a CouchDB delete were all invisible or stale with no way to fix it. Unlike the
  ingest hot path it waits on Meilisearch's asynchronous validation and reports
  failures.

### Fixed

- **`/health` reported `degraded` on any CouchDB with credentials.** The check built a
  URL carrying userinfo (`http://user:pass@host`), but `fetch` doesn't send userinfo —
  CouchDB saw an anonymous request and answered 401, which the check faithfully
  reported as "rejected the credentials". Credentials now go in an `Authorization`
  header. This also made `cli doctor` refuse to run, since it checks health first.
- **Long admin requests had their connection dropped after 10s.** Bun's default
  `idleTimeout` is shorter than a full search rebuild (which grows with the corpus),
  so the client saw a socket reset while the server completed the work normally.
  Raised to Bun's maximum.

- **Content search indexed nothing — every turn document was silently rejected.** Turn
  ids were built as `<session>:<byteStart>:<index>`, but Meilisearch only accepts
  `a-zA-Z0-9`, `-` and `_` in a document id, and it enforces that *asynchronously*: the
  `POST` returned `202` and the batch failed later in the task queue, where nothing was
  looking. 9,362 turn documents had been accepted and zero indexed, so the `turns` index
  sat empty while the sessions index looked healthy. Ids now go through `searchDocId()`,
  with unit tests pinning the character set and the stability that makes re-ingest
  replace rather than duplicate.

- **A transcript was unreadable until SessionEnd had uploaded it to S3**, so a session
  that was still running — or that died before finalising — showed metadata and nothing
  else, even though its chunk docs already held the content. The reader now serves from
  the chunk docs by default and falls back to S3 only when that reaches further
  (whichever covers more bytes, chunks winning ties). New view
  `chunks/entries_by_session` (migration v6) gives the transcript in reading order
  across speakers, and `session_index/aggregate` carries chunk coverage (v7) so
  `hasTranscript` no longer depends on a `summary` doc existing.
- **`test:e2e` never ran anything** — bunfig's `[test] root = "packages"` meant
  `bun test tests/e2e` matched no files. The e2e synth also wrote byte-range-only
  chunks, so its "multi-chunk content" scenario never exercised content chunks; it now
  emits them like the real writer and asserts which store served each read.

- **`release-cli` couldn't build the npm bundle** (surfaced by the 0.0.1 tag run, after
  it had already attached the CLI binaries). `npm version --workspace` reifies the whole
  workspace, and npm can't read the `workspace:` protocol that webapi and webui use —
  `EUNSUPPORTEDPROTOCOL`. The published manifest is now assembled with `jq` and
  `npm publish` runs inside `packages/cli`, so npm never walks the workspace. The
  publish call itself stays unverified while `NPM_TOKEN` is unset.

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

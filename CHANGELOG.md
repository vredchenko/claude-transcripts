# Changelog

All notable changes to **Claude Transcripts** are recorded here. Every component is
**lockstep-versioned** — one `vMAJOR.MINOR.PATCH` tag versions the hook, webapi,
webui, CLI, and shared layer as a set ([ADR 0023](docs/design/decisions/0023-lockstep-versioning-and-combined-image.md)).
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning
is [semver](https://semver.org/spec/v2.0.0.html).

## [0.0.2] — 2026-08-07

The **Tier 1 release candidate**. 0.0.1 was the Tier-1 system standing up end to end;
this is the release where the parts that were merely present became dependable — the
lifecycle operations you need to trust it with real history (`export`/`import`,
`backfill --force`), one-command install, search that finds running sessions and can be
explored rather than only jumped through, and a build where `typecheck`, `lint` and
`gen:all` mean what they say.

Still Tier 1, so still: single machine, single user, **no authentication anywhere**.
Run it on localhost or a private network. What's new here is that the corpus is
portable, re-processable, and searchable — the properties that make it safe to
accumulate history you'd mind losing.

### Added

- **`backfill --force` — re-process a session that was already adopted.** Previously
  `backfill` skipped anything with a summary doc, which made repeat runs cheap and some
  sessions permanently un-fixable: one adopted with `--no-content`, or by a CLI old
  enough to write byte-range-only chunks, had no route back to full-content chunks
  except deleting its documents by hand. `--force` re-processes instead of skipping, and
  `--session <id>` narrows it to one session rather than a whole machine's history.

  It deletes the session's derived docs first (`DELETE /api/ingest/{id}`, new) — not an
  optimisation but a correctness requirement, because re-ingesting over the top doesn't
  replace: event docs get CouchDB-assigned ids and would duplicate, and chunk ids are
  keyed by byte offset, so a session re-chunked at different boundaries would keep its
  old chunks alongside the new and read back doubled. Never deleted: the S3 transcript
  (overwritten) and the on-disk JSONL, so an interrupted forced run is incomplete but
  always recoverable by re-running. Search entries for chunks that no longer exist
  survive until a rebuild, so a forced run ends by telling you to run `reindex`.

- **Non-message transcript lines no longer render blank.** Claude Code's JSONL carries
  far more than user and assistant messages — attachments, file-history snapshots,
  queue operations, mode changes, titles. Over a real corpus that's **36% of all
  entries** (2,183 of 6,103), with `attachment` alone outnumbering user turns, and every
  one of them projected to `role: "other"` with no text: an empty row that expanded to
  nothing useful.

  `ChunkEntry` now carries **`kind`** — the source entry type refined by its own subtype
  (`attachment:hook_success`, `system:turn_duration`, `file-history-snapshot`) — plus a
  one-line summary read from whichever field that type actually carries. On the same
  corpus every one of those rows is now labelled, and half also carry readable text. The
  webui labels rows by `kind` and colours them by family.

  Search still indexes **conversation turns only**. These lines are context, not
  content; indexing them would bury real matches under a thousand identical
  `hook_success` rows.

  Reaches existing sessions when they're re-chunked (`backfill --force`). Migration v8
  redeploys `_design/chunks` so the view emits `kind`; older chunks emit `null` and need
  no rewriting — it's view-only, like every migration so far.

- **Running sessions are findable in search.** The `sessions` index was built from
  `summary` docs alone, so a session became searchable only once it *ended* — its turns
  were searchable while the session itself was not, which is backwards for the case
  you'd search during: work in progress. A session that crashed before `SessionEnd` was
  invisible permanently. Summary-less sessions are now projected from
  `session_index/aggregate`, both on `reindex` and live from the `_changes` feed, so a
  session is findable as soon as it starts.

  Ended sessions keep coming from their summary doc. Projecting them from an event doc
  would have been cheaper and wrong: Meilisearch's add-or-replace would let a sparse,
  event-shaped row overwrite the complete record an ended session already has.

- **Meilisearch index names are configuration, not constants** — resolving
  [ADR 0028](docs/design/decisions/0028-external-vs-bundled-meilisearch.md) in favour of
  *external and namespaced*. CouchDB databases and S3 buckets have always been named in
  `config/` as keyed maps (`claude-transcripts-sessions`); Meilisearch's indexes were
  hard-coded `"sessions"` and `"turns"` — the most collidable names imaginable, on the
  one backing service whose rebuild **clears the index first**. Since `MEILI_HOST` has
  always been settable, a user pointing at an existing Meilisearch could destroy another
  application's `sessions` index by running a supported command.

  Index names now live in `config/` under `meilisearch.indexes`, defaulting to
  `claude-transcripts-sessions` / `claude-transcripts-turns`. Configs written before this
  key existed get the defaults and keep working. An instance upgrading from the old
  names should run `claude-transcripts reindex` to populate the namespaced ones — nothing
  in Meilisearch is authoritative, so there's no data migration — and may then delete the
  two old indexes.

- **`bun run gen:all` no longer reverts shipped fixes or leaves the tree dirty.** The
  documented "regenerate everything" command had four problems, the first of which had
  already bitten:

  - **It dropped `WEBAPI_PORT=7650` from the app service**, silently undoing the fix
    that made the app container bind its own port. The pin lived in the committed
    compose file as a hand-edit; the model never carried it, so the generator couldn't
    emit it. Now in `services.ts`, where it survives regeneration.
  - **`gen:assets` ran before `gen:compose`**, so the assets embedded the *previous*
    compose file and the tree only converged on a second run. Reordered.
  - **`gen-hook-events` wrote `docs/hook-events.md`** while its own docstring and log
    line said `docs/reference/hook-events.md` — leaving a stray file and a stale
    committed one.
  - **`regenerate-compatibility` dropped an untracked `compatibility.json`** at the repo
    root on every run, stamped with the current time. It's a placeholder until the
    generator is wired to a real source, so it's gitignored rather than committed to
    churn.

  The compose generator's header now carries the explanations that used to be inline
  comments in the generated file — those were being destroyed on every regeneration,
  which is how the `WEBAPI_PORT` pin was lost in the first place.

- **A dedicated search results page (`/search`).** The header box is a dropdown capped
  at a handful of hits with no paging or filters — right for "jump to that session",
  useless for "what's in this corpus?". The new page pages through results (20 per
  index), filters by project / model / host / provenance, and shows approximate match
  counts. Its entire state lives in the query string, so a result set is linkable and
  the back button steps through filters and pages; the dropdown now links through to it,
  and Enter opens it.

  `GET /api/search` grew what that needs: `offset`, the filter parameters, `totals`
  (estimated per index — Meilisearch stops counting early on a large corpus, so the page
  says "about"), and `facets` — the available filter values, computed over the whole
  corpus rather than the current page, so the controls don't shrink as you use them.
  `cwd` became a filterable attribute on the sessions index, which existing deployments
  pick up on their next boot or `reindex`.

- **Test fixtures clean up after themselves.** The e2e suite wrote synthetic sessions
  into whatever store it pointed at and never removed them, so running it against a real
  instance meant polluting real history and the search index until you deleted docs by
  hand — a bad property for the suite that exists to tell you the thing works. Every
  session it creates is now deleted in `afterAll` (blob included), and `doctor` removes
  its synthetic session too. `CT_KEEP_FIXTURES=1` and `doctor --keep` leave them when a
  failure needs inspecting.

  Cleanup runs even when tests fail — a failed run is exactly when you re-run, and stale
  fixtures would then collide with the next run's assertions. Failures to clean up are
  reported with the ids, never thrown: turning a red suite a different shade of red
  helps nobody.

  `DELETE /api/ingest/{id}` grew what that needs: it now removes the session's **search
  entries** (previously only `reindex` could, by rebuilding everything), and takes
  `?blobs=true` to delete the transcript. Blob deletion stays opt-in because the
  transcript is the one part of a session that isn't derived — `backfill --force` must
  keep it.

- **`install` sets up and fills the search indexes; `doctor` checks search works.**
  Previously a fresh install left search to look after itself — which it does for
  *new* sessions, since the change follower and the ingest routes both index as they
  write. It doesn't for anything already in CouchDB: the follower starts at *now*, so a
  restored bundle, a reused volume, or an index rename left the corpus unfindable until
  the user discovered `reindex` on their own. `install` now runs it (through the webapi,
  once the app is up) and reports what was indexed; `setup` reports where search stands.

  `doctor` gained a search check — it polls until the session it just wrote turns up in
  search, skipping cleanly when the feature is off. A corpus you can't search is a
  broken install even when every write succeeded, and this surfaces it at setup time
  rather than the first time someone searches.

  Both are best-effort: search is optional, so an engine that's off or unreachable
  reports and moves on rather than failing an install that's otherwise fine.


- **`import` — restore a bundle into an instance.** Verifies the manifest, format and
  every checksum *before* writing anything, so a truncated bundle is refused rather
  than half-restored; refuses a bundle from a newer schema than the target, because
  migrations only run forward. Writes through `/api/ingest/*`, streams transcripts back
  without buffering, and rebuilds the search index at the end. Idempotent: re-importing
  the full 7,135-doc bundle writes zero duplicate docs, because every doc carries its
  source `_id`. Verified by destroying a session outright — CouchDB docs and S3 object
  — and restoring it with every detail field, token count and transcript entry
  identical.

- **`export` — dump an instance to a portable bundle**
  ([bundles.md](docs/design/bundles.md)). A bundle is a directory carrying the CouchDB
  docs (`_id` preserved, `_rev` stripped), the S3 transcripts byte-for-byte, and a
  manifest recording the **schema version** it was taken at — which is what will let
  `import` migrate older data forward. It carries only what can't be recomputed:
  design docs, the schema marker, the search checkpoint, the search indexes and the
  instance env are all excluded. Everything streams, so a corpus far larger than
  memory exports fine, and the manifest is written last so an interrupted export is
  visibly incomplete rather than quietly short. `--no-blobs` gives a bundle roughly a
  tenth the size that still restores search and the chunk-first transcript read;
  `--session` / `--since` narrow the selection. Bundles are 0600 in a 0700 directory —
  a bundle is, in full, everything ever typed into Claude Code on that machine.
  Together with `import`, this is the dump → replace → restore path: an instance can
  now be torn down and rebuilt without losing its history.

- **One-command install.** `curl … | sh` fetches the release binary, verifies its
  checksum and runs `claude-transcripts install`, which generates the instance's
  secrets and ports, starts the backing services, provisions CouchDB and Garage,
  starts the app, registers the hook, and tells you how to verify it. Every phase is
  also its own command (`stack`, `provision`, `hook install`), each idempotent, and a
  failure names the one command that resumes from it. Preflight refuses to change
  anything unless the install can actually work — and distinguishes failures that look
  alike but need different fixes, like a Docker daemon that isn't running versus a
  socket you lack permission for. Also `uninstall`, which keeps recorded history
  unless `--purge`. Design: [installation.md](docs/design/installation.md).

- **The CLI is now the hook.** Registration points Claude Code at
  `claude-transcripts hook run` instead of `bun run <repo>/hooks/scripts/dispatch.ts`,
  so a user needs neither Bun nor a repo checkout, hook behaviour upgrades atomically
  with the binary, and each event starts faster (nothing to transpile). Registration
  merges into `~/.claude/settings.json` and never disturbs another tool's hooks. The
  standalone plugin under `hooks/` is unchanged for contributors.

- **Deployment assets are embedded in the binary** (`bun run gen:assets`) and written
  out at install time, so there's no second download and no way for the compose files
  to drift from the code that drives them.

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

### Changed

- **The OpenAPI spec names its schemas, and both API clients are generated again.**
  The webui's client was hand-written despite being called `generated.ts`, contradicting
  [ADR 0019](docs/design/decisions/0019-openapi-source-of-truth-generated-clients.md) —
  `gen:clients` would have overwritten it with something that didn't compile. The cause
  wasn't the transport, it was that **every schema was inlined**: orval could only name
  a type after the route it appeared in, so `SessionStatus` came out as
  `ListSessions200SessionsItemStatus` and hand-writing genuinely read better.
  Response schemas are now registered as named components, so generated types carry
  their real names, and orval emits the webui client (react-query over `fetch`, with a
  mutator that unwraps responses and throws on non-2xx so react-query sees failures).
  `gen:clients` also formats its output, so generated code passes `lint` without being
  hand-edited or exempted.

- **Numeric query parameters are declared as integers.** `limit`, `skip` and `offset`
  were typed `string` in the spec while every handler did `Number(...)` — so clients
  had to pass strings for values that are plainly numbers. They're now `integer`
  (coerced, minimum 0). One behaviour change falls out: a malformed value like
  `?limit=abc` returns **400** instead of being silently treated as an empty page.

- **Request-validation failures match the API's error shape.** A failed query/body
  validation returned a raw serialised `ZodError` — a shape nothing else in the API
  uses and the spec never described. It now returns `{ error: "invalid request — limit:
  Expected number, received nan" }` with the 400 declared on the affected routes, so a
  client that can read one error can read all of them.


- **BREAKING — `GET /api/sessions/{id}/transcript` now returns
  `{ entries, totalCount, hasMore, source, byteCoverage }`**; the `messages` array of
  raw Claude Code JSONL is gone. Chunk docs store pruned per-turn entries rather than
  raw bytes, so reading them first is necessarily a fidelity change; both sources
  normalise through `buildChunkEntries`, so the shape never varies with `source`.
  Byte-exact JSONL stays available via the read-only S3 proxy
  (`/api/s3/sessions/<id>/transcript.jsonl`). This narrows
  [ADR 0014](docs/design/decisions/0014-transcripts-live-in-s3-only.md): S3 is still
  the durable home, but no longer the read path.

### Fixed

- **`typecheck` no longer depends on which copy of `@types/react` gets hoisted.** The
  CLI pinned `@types/react@^18.3.12` for Ink 5 while the webui asked for `^19`, and the
  workspace hoists one copy to the root — so MUI and Emotion (also hoisted) resolved
  whichever major won, while the webui's own code resolved its nested one. When those
  disagreed, three errors appeared, because React 19's `ReactNode` admits `bigint` and
  18's doesn't.

  Which way it fell was **not stable across machines**: with the same lockfile, CI
  resolved it green while a clean `bun install --frozen-lockfile` locally resolved it
  red. A gate whose answer depends on the resolver is worse than one that always fails
  — a green CI said nothing about the maintainer's checkout, and vice versa.

  Fixed by removing the split rather than arranging around it: **Ink 5 → 6** takes React
  19, so the monorepo runs one React version and hoist order can't decide anything.
  Deliberately *not* Ink 7 — it renders nothing when stdout isn't a TTY, which would
  make `claude-transcripts | grep` and any captured help output silently empty.

- **`import` no longer trusts "the bundle is older, so it's fine".** Restoring an old
  bundle into a newer instance is safe only while the migrations in between are
  view-only — CouchDB rebuilds views over the restored docs, so nothing needs migrating
  forward. A migration that reshapes *documents* breaks that silently: the marker is
  per-database, so the target already counts the transform as applied, `migrate up` finds
  nothing pending, and the restored docs keep their old shape permanently. Migrations can
  now declare `transformsDocs`, and import refuses any bundle whose version gap contains
  one, naming them. No migration sets it today — every one is view-only, and a test
  asserts that — so nothing changes in practice; the trap is armed rather than sprung
  later. The scoped replay that would lift the refusal waits for the first document
  migration, since until one exists there is nothing to test a replay against.
  [ADR 0021](docs/design/decisions/0021-self-built-couchdb-migrations.md) is amended
  accordingly: import **verifies** rather than migrates forward.

- **`import` gave the wrong fix for a bundle from a newer schema.** It compared only
  against the instance's applied version and always advised `migrate up` — useless when
  the *build* is the thing that's too old, since `migrate up` reaches its own ceiling and
  fails identically. It now distinguishes an instance behind its own build (run
  `migrate up`) from a build that has never heard of that schema (upgrade the app).

- **`import` refused bundles written by older CLIs.** The format check rejected any
  version that wasn't an exact match, defeating the reason `format` is versioned
  separately from the app: a bundle outlives the release that wrote it. Only a format
  from the future is refused now.

- **`import` treated an unreachable webapi as a pristine instance.** A failed status
  read returned v0, which is a real version — so the version comparison took a branch it
  had no evidence for. It now fails up front, naming the URL.


- **No app image tracked `main`, so an install could only get a released one.**
  `latest` correctly means "newest release", but with nothing published between
  releases the app image sat at schema v5 while `main` reached v7 — pairing a current
  CLI with a months-old app, which breaks lockstep versioning
  ([ADR 0023](docs/design/decisions/0023-lockstep-versioning-and-combined-image.md))
  silently, since everything starts and only some later read misbehaves. Every merge
  to `main` now publishes `:main`; `latest` still moves only on a release. `install`
  pins the image to the CLI's own version when released and to `main` when not, then
  reports the version the running app announces so skew is visible.

- **`/health` and the read-only `/api/couch` proxy both 401'd against an authenticated
  CouchDB.** Each built a URL carrying userinfo (`http://user:pass@host`), but `fetch`
  doesn't send userinfo — CouchDB saw an anonymous request and answered 401, which
  `/health` faithfully reported as "rejected the credentials" while the proxy rejected
  every read. Having hit the same trap twice, the conversion now lives in one place
  (`couchFetch`). This had also been blocking `cli doctor`, which checks health first.
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

[0.0.2]: https://github.com/vredchenko/claude-transcripts/releases/tag/v0.0.2
[0.0.1]: https://github.com/vredchenko/claude-transcripts/releases/tag/v0.0.1

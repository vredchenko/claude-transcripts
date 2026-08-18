# Changelog

All notable changes to **Claude Transcripts** are recorded here. Every component is
**lockstep-versioned** — one `vMAJOR.MINOR.PATCH` tag versions the hook, webapi,
webui, CLI, and shared layer as a set ([ADR 0023](docs/design/decisions/0023-lockstep-versioning-and-combined-image.md)).
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning
is [semver](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **The hook can mirror to a second instance.** A `mirrors` array in the hook's runtime
  config writes every session to another instance as well as the local one, live
  ([mirrors.md](docs/operate/mirrors.md)).

  A mirror could not be expressed as a second `couch.url`, which is the whole reason
  this is code rather than configuration: a remote instance's CouchDB and S3 are bound
  to *its* localhost and are not reachable, and the webapi's `/api/couch` and `/api/s3`
  proxies are read-only by design. The one write surface a remote instance offers is
  `/api/ingest` — the same one `import` restores a bundle through — so a mirror is a
  live, incremental import, and the document shapes were already known to travel.

  The fan-out is a composite `CouchClient`/`BlobClient` rather than a change to the
  handlers, so "write to two places" stays a config fact instead of something each of
  the six handlers has to remember. Writes to all targets start together, so the local
  store is never queued behind a remote one, and an event costs `max(local, mirror)`
  rather than the sum. Every request is bounded by its own timeout — short for
  per-event writes, since `PostToolUse` fires on every tool call inside a 5s hook
  budget, and generous for the `SessionEnd` transcript upload.

  There is no retry queue, and the documentation says so plainly: a write that fails
  while the mirror is down is lost *to the mirror*, and the remedy is an
  `export --since` / `import` backfill, which is idempotent. The local copy is never
  affected either way.

## [0.0.9] — 2026-08-12

An upgrade cleans up after itself.

### Added

- **`install` reclaims the app images it supersedes.** Compose pulls but never prunes,
  so nothing in the normal path removed the predecessor image: a few releases in, a
  machine carries several hundred megabytes per version it has passed through. The cost
  isn't untidiness — the *next* upgrade needs room for a fresh pull, and the failure
  mode when it doesn't have it is a half-extracted layer at the least recoverable
  moment. Found on an instance whose disk had reached 100% while holding four
  superseded tags alongside the one it was running.

  The scope is deliberately narrow, because the blast radius of getting this wrong is
  the running instance. Only `${IMAGE_NS}/claude-transcripts-app`, the image the
  installer itself pulls — never a contributor's locally built `:local`, and never a
  bare `docker image prune`, which would reach clean out of the instance into whatever
  else the machine runs. Only after the new image has answered a health check, since
  pruning earlier spends the rollback target to make room for an image not yet known to
  work. Never the tag just installed, nor the one it replaced, so a rollback stays an
  `APP_TAG` edit rather than a re-pull. And never forced: `docker rmi` refuses to remove
  an image a container still references, and that refusal is the safety check rather
  than something to work around. `--no-prune` opts out.

  Removal goes by `repo:tag` rather than image ID, because one ID can carry several
  tags — deleting `v0.0.8` by ID would take `latest` with it when they point at the same
  build. Retention needs no version sorting: the tag being replaced is already read from
  the instance env, so "current plus predecessor" falls out of what the installer
  already knows. The selection is pure and unit-tested, because it runs unattended after
  the install has already succeeded, and deleting the wrong image reports nothing until
  the next `up`.

  Reported as counts and tags rather than bytes: images share base layers, so a total
  summed from what `docker images` prints overstates what was actually freed — on the
  instance above, four 418MB images reclaimed 1.0GB, not 1.7GB.

## [0.0.8] — 2026-08-12

The webui gets two more ways to read a corpus, search stops making you hunt for your own
query, and CI learns to check three claims the repo had been making on trust.

### Added

- **Two more projections of the session list.** The table answers "compare these
  sessions" well and "what was I doing on Tuesday" badly. A session is an *interval* —
  the corpus holds one that ran four days — so it now also renders as a **timeline**
  (vertical, grouped by day, at three switchable densities including one spaced by real
  elapsed time) and a **calendar** (a month grid drawing each session as a bar across
  every day it covers, and a day view placing sessions by clock time with concurrent
  ones side by side). The projection lives in the URL, so a view is linkable.

  The placement arithmetic is pure and unit-tested, because every mistake in it is
  silent: local time rather than UTC (`toISOString().slice(0,10)` files an evening
  session under tomorrow west of Greenwich), day lengths computed per cell so a DST
  transition doesn't drift the grid, half-open day boundaries so a session ending at
  midnight doesn't paint a sliver on the next day.

- **`GET /api/sessions` takes `from`/`to`**, matching on **overlap** rather than
  containment — asking for a month must not drop the session that began the previous
  week. The route already materialised every session before slicing, so this needed no
  view or migration change.

- **Search shows what matched, and takes you to it.** Meilisearch always knew which
  tokens matched; the route never asked. It does now, for both indexes, and the query
  rides along in `?q=` so a result opens the session *on the match* — expanded,
  outlined, scrolled to — instead of at entry #0 of a five-thousand-entry transcript.
  Session hits also say **why** they matched (`matchedIn`), and snippets carry 90 words
  of context rather than 40.

  The highlight marks are private-use codepoints, not `<em>`. Meilisearch's default
  invites rendering a snippet as HTML, which would be stored XSS in an app whose whole
  purpose is displaying other people's raw session logs.

- **A browser test suite** (`bun run test:browser`) over **Chromium and Firefox** at two
  widths, with every `/api` call answered from a synthetic corpus so it needs no stack
  and runs in CI. It measures *geometry* as well as content, because the bugs this UI
  grows pass every assertion about content while being visibly wrong. It found eight on
  arrival, all fixed below.

  Both engines earn their place: an overflowing row that Blink places over the pointer
  (so a click never lands) is click-through in Gecko, and elsewhere Gecko's click lands
  silently on the wrong element — the worse failure, and invisible with one engine.

### Fixed

- **Transcript rows escaped their card, in both directions at once.**
  `.MuiAccordionSummary-content` is a flex container with no `min-width: 0`, so a
  single unwrapped preview line — a path, a caveat block, anything without spaces —
  forced the row to its max-content width and spilled it out over the controls beneath.
  Fixed in the theme rather than at the call site: it is a property of the component,
  and the next accordion would have inherited it.

- **Every page scrolled sideways on a phone.** The header's search cell had the same
  missing `min-width: 0` and pushed the menus off-screen. That, not the sessions table,
  was the cause. Below `sm` the toolbar now wraps and the search takes its own row —
  making it *fit* by letting it shrink produced a 20-pixel input jammed against the
  settings button, which nothing overflowed and no geometry check could see.

- **The session-detail metadata grid** packs with `auto-fill` instead of a fixed 2/4
  columns that left a ragged hole and forced long values out of their cells; the
  session-id heading wraps; and the header no longer renders `vv0.0.7` — the model's
  `identity.version` already carries the `v`.

- **Paging the calendar into an empty month** replaced the whole view with an empty
  state, taking its own month navigation with it and stranding you there.

- **The transcript's scroll-to-match honours `prefers-reduced-motion`.** Gliding
  through thousands of rows unasked is a vestibular trigger, and it left the page moving
  for a second after load, so anything clicked in that window landed somewhere other
  than where it was aimed.

### Changed

- **CI checks three things the repo previously asserted on trust.**

  - **Generated files must be reproducible.** `packages/webui/src/api/generated.ts`
    spent weeks *hand-written* under a generated name, carrying a header admitting it
    while the docs said clients are generated and must never be hand-edited; the compose
    file drifted the other way, a regeneration silently dropping comments the generator
    can't emit. Nothing could tell the difference, so nothing did. CI now regenerates
    everything and fails on a diff. A file named "generated" that nobody regenerates is
    worse than a hand-written one, because the name suppresses the scrutiny it needs.

  - **The API contract must stay compatible.** Consumers are *generated* from the spec,
    so a breaking change fails at somebody else's next codegen — or silently at runtime
    in a CLI shipped a version ago. `bun run check:contract` diffs a branch's spec
    against the base and fails on changes that break a consumer built from the older
    one, comparing in the right direction: responses may gain fields, requests may relax.
    A deliberate break passes when a commit declares it (`type!:` or `BREAKING CHANGE:`),
    so it reaches this changelog rather than a bug report.

  - **The webui must render correctly**, per the browser suite above.

- **`openapi.json` is now committed.** [ADR 0019](docs/design/decisions/0019-openapi-source-of-truth-generated-clients.md)
  called the spec the single source of truth while `.gitignore` called it a transient
  build input; the consequence was that no contract change was reviewable in a diff or
  comparable across commits. The reproducibility check is what makes committing a
  generated file safe. ADR 0019 carries an amendment recording both.

## [0.0.7] — 2026-08-09

Finishes what 0.0.6 started: the Services menu's last wrong link.

### Fixed

- **The CouchDB link in the Services menu pointed at the container's port.** 0.0.6 made
  those links follow the deployment's resolved ports, which fixed three of the four —
  and gave CouchDB a new wrong answer. The menu is built by the model *inside the app
  container*, and compose pinned `COUCHDB_PORT=5984` there, so the link offered
  `127.0.0.1:5984` to a browser on the host, where nothing listens.

  That pin was redundant: `COUCHDB_URL` is set explicitly and wins for every connection
  (`resolveCouchUrl` checks it first), so the container never needed `COUCHDB_HOST`/
  `COUCHDB_PORT` at all. Removing it lets the host-side values through from `env_file`,
  which is what a link meant for the host requires. A test now asserts the app container
  overrides no host-port variable a menu link depends on, so the next service to grow an
  admin UI can't reintroduce it.

## [0.0.6] — 2026-08-09

Three things that were wrong in ways nothing reported: an installer that skipped the
verification it claimed to do, a menu of links pointing at closed ports, and docs
describing a system a version or two behind the code.

### Changed

- **Docs reconciled against what the code actually does.** A pass over every `.md` in
  the repo plus the app model, prompted by [ADR 0016](docs/design/decisions/0016-webapi-is-the-io-gateway.md)
  describing an exception narrower than the one the code takes.

  - **ADR 0016 amended: the hook is a second writer.** It writes to CouchDB and S3
    directly — all four of its actions — because recording a session must not depend on
    the webapi being up. The ADR's "still delivered *to* the webapi" exception covered
    `backfill`, not the hook. What that costs (no write-time validation, no write-time
    indexing, store credentials on the host) and what covers it (the `_changes`
    follower) is now written down. `CLAUDE.md`, `getting-started.md`,
    `couchdb-documents.md` and a stale code comment all repeated the too-narrow version.
  - **The README led with the contributor path** and stated that nothing was released,
    with no mention of the one-command installer. It now opens with `curl | sh`, and
    the from-source steps are marked as such. Its claim that the hook runs
    `hooks/scripts/dispatch.ts` was two refactors out of date.
  - **`cli.md` said "specified, not yet built"** for a CLI that ships as a released
    binary, and listed an anticipated command surface instead of the real one.
  - **Design docs were described as mirrored** between `hooks/couchdb/` and
    `ensure.ts`. That mirror is gone; the migration registry owns them.
  - **`webapi.md` said nothing follows CouchDB's change feed** — the follower has
    existed since search went live — and named the pre-ADR-0028 index names.
  - **The model's `ROUTES` was missing whole families** (search, ingest, migrate,
    turns, health, docs, cli download), so the manifest at `/` under-described the
    surface an agent arrives at. It stays a coarse family map by design: per-endpoint
    detail belongs to the OpenAPI spec.
  - Nine references to files that no longer exist, and `schema_version` marked
    "planned" when migrations have been writing it since v1.

### Fixed

- **The Services menu links to this deployment's real ports.** They were literals
  hard-coded to the bundled dev defaults (7652, 7655, 7656, 7657) in `LinksMenu`, and
  `servicesMenu` was passed through from `config/` as URLs carrying those same defaults.
  `install` generates a per-instance port block, so on any instance that didn't happen
  to get the defaults **every link in the menu pointed at a closed port** — while
  sitting in the instance's own `app.json`, looking authoritative.

  The app model now derives them from each service's *resolved* host port, so they
  follow the env the instance actually runs with; derived entries win over the config
  file, because a stale default in an existing `app.json` must not override the truth.
  Config keys the model doesn't know are still carried through, so an operator can add
  their own links. Meilisearch's own UI gained a menu key it had been missing, and
  CouchDB keeps its `/_utils/` path rather than linking the bare root.

  The webui reads them from `/api/model` instead of literals, and omits the group
  entirely when the model is unreachable — a menu of links that don't work is worse
  than no menu.

- **`install.sh` actually verifies the binary it downloads.** It looked for a combined
  `checksums.txt`, which no release has ever published — releases carry a per-asset
  `<name>.sha256`. The fetch 404'd, the "no checksums published — skipping verification"
  branch ran, and **every install piped an unverified binary onto the user's PATH while
  reporting success**. The comment directly above that code says this is "not something
  to be relaxed about", which was true and unimplemented.

  It now reads `<asset>.sha256`, and a missing, empty or mismatched checksum — or no
  `sha256sum`/`shasum` to check with — is a hard failure rather than a silent skip. A
  release without a checksum is a problem to stop on, not to shrug at.

## [0.0.5] — 2026-08-09

Makes an upgrade a single command. Both fixes are about a released CLI knowing what it
is — until now one didn't, so it pinned the wrong image and disabled the check that
would have said so.

### Fixed

- **A released CLI knew its own version, and pinned the app image to it.** `CT_VERSION`
  was baked into the Docker image but never into the compiled CLI binary, so every
  released binary reported `0.0.0-dev` — and each decision keyed off "is this a release"
  silently took the dev branch: the app-image pin resolved to `main` instead of the
  release, the version-skew warning was disabled outright, and the written asset stamp
  said `0.0.0-dev`. Both compile sites (`release-cli.yml` and the Dockerfile's bundled
  CLI) now inject it.

- **`install` re-pins the app image on every run.** `APP_TAG` was written only when an
  instance was *created*; afterwards the env merge preserved whatever was on disk. An
  instance created once at `latest` therefore kept pulling `latest` forever while its
  CLI moved on — and since Docker reuses a cached tag, an upgrade could leave a months-
  old image running with nothing reporting a problem. It's now installer-owned:
  recomputed each run, overwriting the file, and the change is logged. Ports, secrets
  and everything else the instance chose are still preserved.

  Together these are why upgrading a real instance to 0.0.3 quietly started **v0.0.1**,
  whose health check then failed against an authenticated CouchDB.

## [0.0.4] — 2026-08-08

Two fixes for problems that only appear on a **real install**, both found by upgrading
one to 0.0.3 rather than by reading the code. Neither is reachable on a default-port
install that has never been registered any other way, which is why 0.0.3 shipped with
them.

### Fixed

- **`hook install` replaces a stale registration instead of adding a second one.** It
  skipped only on an exact command-string match, so switching form — a checkout running
  the hook from source, then the installed binary — left **both** registered. Every
  event then fired two writers, double-writing event docs into CouchDB (summaries upsert
  and chunks have stable ids, so events were the ones that duplicated). Registrations
  belonging to this tool in any of its forms are now removed before the current one is
  written; other tools' hooks are matched out and never touched.

  Found by upgrading a real instance from a source install to the released binary — the
  install reported success and left 11 events registered twice.

- **CLI commands find the instance's own webapi.** `install` generates a port per
  instance, so an install is frequently not on the default 7650 — but the CLI resolved
  its URL from environment variables alone and fell back to 7650 regardless. Every
  command (`sessions`, `doctor`, `reindex`) then reported a dead webapi on a port
  nothing was listening on, unless told `--webapi` every time. Resolution now falls back
  to the installed instance's generated `instance.env` before the default, with explicit
  env vars still winning so a dev checkout can point at a webapi it runs from source.

  Found by upgrading a real instance: `install`'s own search step hit 7650 while the
  instance ran on 7658, so it reported `ECONNREFUSED` and told the user to retry
  something that would have failed the same way — inside an install that otherwise
  announced success.

## [0.0.3] — 2026-08-08

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

- **The docs site's internal links are checked in CI.** `v0.0.2` was tagged and then
  its app image failed to build: the docs site is compiled into the image and fails on a
  broken internal link, and there were four — all in `docs/reference/hook-events.md`,
  which is generated. Fixing that generator's output path earlier in this release meant
  the file landed a directory deeper than its link templates assumed, and the committed
  copy had been stale long enough to hide it.

  The links are now relative to where the file actually goes. More usefully, `ci.yml`
  now runs `bun run build:docs`: it previously ran lint, typecheck, build and test, none
  of which touch the docs, so the first sign of a broken link was a release image
  refusing to build — after the tag was pushed and after the CLI binaries had already
  been published against it.

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

## [0.0.2] — never published

Tagged, then abandoned: the app image failed to build (a broken internal doc link, fixed
in 0.0.3), so the tag published CLI binaries that pin an image which does not exist.
`latest` never moved onto it. The tag and its GitHub Release are kept, marked, and
superseded by 0.0.3 — which is the same code plus the fix. Nothing here was released
twice; 0.0.3 carries the whole changelog above.

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

[0.0.9]: https://github.com/vredchenko/claude-transcripts/releases/tag/v0.0.9
[0.0.8]: https://github.com/vredchenko/claude-transcripts/releases/tag/v0.0.8
[0.0.7]: https://github.com/vredchenko/claude-transcripts/releases/tag/v0.0.7
[0.0.6]: https://github.com/vredchenko/claude-transcripts/releases/tag/v0.0.6
[0.0.5]: https://github.com/vredchenko/claude-transcripts/releases/tag/v0.0.5
[0.0.4]: https://github.com/vredchenko/claude-transcripts/releases/tag/v0.0.4
[0.0.3]: https://github.com/vredchenko/claude-transcripts/releases/tag/v0.0.3
[0.0.2]: https://github.com/vredchenko/claude-transcripts/releases/tag/v0.0.2
[0.0.1]: https://github.com/vredchenko/claude-transcripts/releases/tag/v0.0.1

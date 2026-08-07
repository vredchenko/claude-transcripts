# Roadmap

The work is organised into **three stacking tiers** ([tiers.md](tiers.md)):
**Tier 1** single-machine retention + browse/search (current focus), **Tier 2**
making history actively useful to future agents (recall, self-learning, analytics,
multi-user), **Tier 3** multiplayer + public release. The future-scope issues
below map onto Tiers 2–3. A [competitive-landscape](competitive-landscape.md)
survey (issues #18–#30) informs the Tier-2 recall/memory direction.

**Phase 1** (current, Tier 1) recreates, as a single standalone project, the
logging + viewing that previously lived across several repos. The UI is functional
and themed (MUI, light/dark) but has had no visual design pass — that comes later.

The **logging rework** (#4) is now complete end to end. Transcripts live in S3 only
([ADR 0014](decisions/0014-transcripts-live-in-s3-only.md)); the hook flushes
append-only `chunk` docs mid-session (crash resilience), ingested idempotently with
stable ids; and those chunks now carry **full content** — each turn's role + text —
not just a byte range ([ADR 0027](decisions/0027-full-content-chunks-in-couchdb.md)).
That made CouchDB able to see individual turns, which is what the speaker-split views,
per-turn search, and the chunk-first transcript read are all built on.

Two consequences worth stating, because they changed how the system behaves:

- **Reading a transcript no longer waits for the session to end.** `GET
  /api/sessions/{id}/transcript` serves from the chunk docs by default and falls back
  to the S3 blob only when that reaches further, so a live — or crashed — session is
  readable. This narrows ADR 0014: S3 is still the durable home, no longer the read
  path.
- **Search is wired and populated.** Meilisearch indexes both session metadata and
  conversation content, kept current by a CouchDB `_changes` follower, with
  `POST /api/search/reindex` (`cli reindex`) as the reconciliation step.

## Tier 1 build (current scope)

The concrete Tier-1 deliverables are enumerated in
[tiers.md → Tier-1 build scope](tiers.md#tier-1-build-scope): structured app config
(multi-db/bucket), CouchDB schemas-in-code + migrations, webapi/CLI/webui scaffolds,
dev automation (orval client gen), the dev full-stack compose + admin UIs, mirrored
backing images, lockstep versioning + combined image, the CC compatibility
generator + hook table, and the single-`main` branch model. The **e2e test suite**
([testing.md](../develop/testing.md)) is the gate from Tier 1 into Tier 2 — built and
passing, covering baseline / multi-chunk / subagent / crashed-session scenarios plus
both transcript read paths.

### Tier 1 — open work

The near-term list, mostly surfaced by using the system rather than planned up front.
Ordered roughly by how much they get in the way.

**Export / import bundles — done** ([bundles.md](bundles.md)). An instance can be
dumped, torn down, replaced with a clean install, and restored; verified against a real
7,135-doc corpus, including destroying a session outright and restoring it byte-for-byte.
A bundle carries the data **plus the schema version it was taken at**, which is what lets
import decide whether a restore is sound.

Remaining, and deferred deliberately: import cannot yet restore a bundle **across a
document-reshaping migration**. Migrations are recorded per database, so importing
old-shaped docs into a database that already counts the transform as applied would leave
two shapes behind with nothing pending to fix them. No such migration exists — all eight
are view-only — so import refuses that case (`transformsDocs`) rather than implementing a
scoped replay that could not be tested against anything. The replay is work for whenever
the first document migration is written.

**Install & first run** — the biggest remaining Tier-1 gap. Getting from `git clone`
to "sessions are being logged" currently means running the stack, provisioning stores,
generating hook config and registering the hook, with the pieces spread across
`cli setup`, `scripts/`, and `deploy/`. It needs to be one obvious, idempotent,
re-runnable path with a clear "is this working?" answer at the end — this is what
[`doctor`](../operate/tools.md) checks after the fact. Public-repo critical: it's the
first thing a new user touches ([configuration.md](../start/configuration.md)).

**Ingest & data fidelity**
- **`backfill` can't re-process an adopted session — fixed.** `--force` (optionally
  narrowed by `--session <id>`) re-processes instead of skipping, which is how a session
  adopted with `--no-content`, or by a CLI old enough to write byte-range-only chunks,
  gets rebuilt into full-content chunks. It deletes the session's derived docs first,
  because re-ingesting over the top doesn't replace them: event ids are CouchDB-assigned
  so they'd duplicate, and chunk ids are keyed by byte offset so re-chunking would leave
  the old ones behind. The S3 transcript is only ever overwritten, never deleted, so an
  interrupted run is always recoverable by re-running.
- **Non-message transcript lines render blank — fixed.** Claude Code's JSONL carries
  far more than conversation turns: attachments, file-history snapshots, queue
  operations, mode changes, titles. Measured over a real corpus, **36% of all entries**
  (2,183 of 6,103) were these — `attachment` alone outnumbers user turns — and every one
  projected to `role: "other"` with no text, i.e. an empty row that expanded to nothing.
  `ChunkEntry` now carries `kind` (the source type, refined by subtype:
  `attachment:hook_success`, `system:turn_duration`) plus a one-line summary of the
  field each type actually holds. On the same corpus every one of those rows is now
  labelled and half also carry readable text. Search deliberately still indexes only
  conversation turns — a thousand identical `hook_success` rows would bury real matches.
  Existing sessions pick it up when re-chunked with `backfill --force`.

**Search**
- **Metadata search misses running sessions — fixed.** The `sessions` index was built
  from `summary` docs, so a session became findable only once it ended — and a crashed
  one never did. Summary-less sessions are now projected from `session_index/aggregate`,
  both on `reindex` and live off the `_changes` feed. Ended sessions keep coming from
  their summary doc: projecting them from an event would let Meilisearch's
  add-or-replace put a sparse row over a complete one.
- **No dedicated results page.** The header box is a dropdown capped at a handful of
  hits, with no paging, filters, or ranking controls — fine for "jump to that
  session", not for exploring the corpus.
- **[ADR 0028](decisions/0028-external-vs-bundled-meilisearch.md) — decided:** external
  and namespaced. Meilisearch's indexes were bare `sessions` / `turns` constants while
  every other store's names live in `config/`, so pointing `MEILI_HOST` at an existing
  engine — which config always allowed — could have let `reindex` clear someone else's
  index. Index names are now config, defaulting to `claude-transcripts-*`. The bundled
  instance stays the default and the tested configuration.

**Quality & debt**
- **The webui typechecks against the wrong React types — fixed.** `packages/cli` (Ink 5)
  pinned `@types/react@^18.3.12` while `packages/webui` asked for `^19`, and the
  workspace hoists one copy — so MUI and Emotion resolved whichever major won the hoist
  while the webui's own code resolved its nested one, and the two `ReactNode`s disagree
  about `bigint`. Worth recording precisely, because it isn't "the gate was red": with
  the *same lockfile*, CI resolved it green while a clean local
  `bun install --frozen-lockfile` resolved it red. A check whose answer depends on the
  resolver tells you nothing either way. The fix was to stop having two React majors:
  Ink 6 takes React 19, so hoist order can no longer decide anything. (Ink 7 was the
  obvious jump and is wrong here — it renders nothing when stdout isn't a TTY, so
  `claude-transcripts | grep` would silently print an empty help screen.)
- **The webui API client is hand-maintained, contradicting
  [ADR 0019](decisions/0019-openapi-source-of-truth-generated-clients.md) — fixed.**
  Orval now emits the webui's client too (`httpClient: "fetch"` + a mutator), so both
  consumers are faithful generated output and `gen:clients` no longer destroys work.
  The blocker wasn't really the transport: the spec **inlined every schema**, so
  generated types were named after the route they appeared in
  (`ListSessions200SessionsItemStatus`), which is why hand-writing looked preferable.
  Registering the schemas as named components fixed the cause. Details in
  [dev-automation.md](../develop/dev-automation.md#client-generation-orval).
- **A transcript entry's absent fields are spelled two ways.** The
  `chunks/entries_by_session` view emits `toolUses: e.toolUses || null`, while the S3
  path builds entries with `buildChunkEntries`, which omits the field. Same meaning,
  two encodings, so `TranscriptEntry` has to declare `null | undefined` and every
  consumer handles both. Converging them means a view migration (emit the field only
  when present) — small, but it changes a design doc, so it wants its own change rather
  than riding along with something else.
- **The e2e suite leaves fixtures behind.** It writes synthetic sessions into whatever
  store it points at and never cleans up, so running it against a real instance
  pollutes real history (and the search index) until they're deleted by hand.
- **The hook exists twice — fixed.** `sumTranscriptTokens` and the chunking helpers
  were kept **byte-identical** between `shared` and `hooks/` for one reason: a plugin
  directory can't resolve the workspace. That stopped being true once the CLI became
  the hook, so `hooks/` is now a shim that pipes its payload to
  `claude-transcripts hook run` — about 500 lines of second implementation deleted,
  along with the "keep these two files identical" rule and its drift risk. The plugin
  now requires the CLI to be installed, which is the right trade: it was never the
  primary install path ([ADR 0004](decisions/0004-bun-monorepo-hook-as-standalone-plugin.md)
  is amended).

## Future scope → captured in docs

The design discussion that used to live in the issue tracker has been **folded
into `docs/` and the tracking issues closed** (only the competitor-study issues
**#18–#30** remain open). This section is the tier-mapped index; the original issue
number is kept in parentheses for provenance. Items are open work unless marked
done.

**North star (Tier 2/3)**
- Agent-first session corpus — recall + self-retrospective, CC as the primary
  consumer; single-instance-but-multiplayer-aware now, multiplayer later
  ([tiers.md](tiers.md), [session-corpus-design-discussion.md](session-corpus-design-discussion.md)) (#15)
- Evaluate DeltaDB-style delta granularity ([database-choice.md](database-choice.md)) (#16)

**Logging & data model (Tier 1/2)**
- **Full-content chunks** (#4) — **done, read and write**: the hook + `backfill` embed
  parsed per-turn `entries[]` (role + content) in `chunk` docs when
  `couchFullContentChunks` is on, validated at the webapi
  ([ADR 0027](decisions/0027-full-content-chunks-in-couchdb.md),
  [mid-flight-chunking.md](mid-flight-chunking.md)). The views over `entries[]` all
  exist — `speaker_split/by_role` + `by_role_time` (v4/v5) and
  `chunks/entries_by_session` (v6, transcript order across speakers), which backs the
  chunk-first transcript read. Content chunks are written by default by both the hook
  and `backfill`, so newly adopted history needs no follow-up.
  Remaining, and only for deployments that adopted history **before** this landed or
  with `--no-content`: those sessions have byte-range-only chunks, so they fall back to
  S3 on read and contribute nothing to content search. There's currently no way to
  redo them — `backfill` skips any session that already has a summary doc — so the fix
  is either a re-process flag on `backfill` or a migration that rebuilds chunks from
  the S3 transcript.
- Session enrichment: harness config / PROMPT / MCP / plugins / CLI version
  ([actions.md](../reference/actions.md), [hooks.md](../reference/hooks.md)) (#3)
- Multi-user / multi-machine attribution ([tiers.md](tiers.md) → T2) (#7)
  - **System fingerprint per session** — record a machine fingerprint on every
    session so a store written to by more than one machine stays attributable
    (groundwork for multiplayer).
  - **Claude account identity** — capture the Claude account user (username / email
    / id) per session, laying the ground for multi-user once we go multiplayer.
- Secrets scanning + masking ([app-logging.md](../operate/app-logging.md), #11)
- **Git-change capture** *(Tier 2)* — record the code changes Claude authors per
  session as structured data (changed paths, unified diffs, and any commits it
  makes), not just the `Edit`/`Write`/`Bash` tool calls buried in the transcript.
  A `PostToolUse` hook on write tools plus a Stop/SessionEnd `git diff` snapshot
  (or watching the repo) would give a first-class "what did this session change"
  record for analytics + recall. *Partially latent today* (Edit/Write inputs live
  in the transcript content) but not collected as structured diffs.
- **Claude Code API traffic capture** *(Tier 2/3)* — the model I/O (system prompt,
  tool schemas, exact request/response bodies, per-request token headers) is **not**
  in transcripts or anywhere else — it goes straight to the Anthropic API over TLS.
  Capturable via an **opt-in local MITM proxy** (e.g. mitmproxy) with its CA trusted
  by Claude Code (`HTTPS_PROXY` + `NODE_EXTRA_CA_CERTS`); the CLI is a Node/Bun app
  and honours those, so no cert-pinning workaround is needed. High-value but
  privacy-sensitive (raw prompts/keys) → strictly opt-in, masked, and off by
  default. (Supersedes the old "consider" #2.)
- **Speaker-split views** — **done**: `speaker_split/by_role` (v4, per-session,
  `GET /api/sessions/{id}/turns`) and `speaker_split/by_role_time` (v5, **cross-session**
  in time order, `GET /api/turns`) map over `chunk.entries[]`
  ([ADR 0027](decisions/0027-full-content-chunks-in-couchdb.md)). The webui session
  detail has the per-speaker toggle (Full / You / Claude). Remaining: a cross-session
  browser over `by_role_time` (the API is live at `GET /api/turns`; nothing in the
  webui reads it yet).
- **Cross-project speech-pattern analysis** *(Tier 2)* — built on `by_role_time`:
  cluster/aggregate what the user repeatedly says (recurring instructions →
  candidates for CLAUDE.md / memory) and what Claude repeatedly says (recurring
  caveats/refusals/patterns). The view is the corpus; the analysis (n-grams,
  embeddings, dedup) is a scheduled-task job ([tiers.md](tiers.md) → T2).
- **Active vs wall-clock session duration** — alongside total runtime (first→last
  event), compute *active* duration by summing only intervals where something was
  happening (gaps beyond an idle threshold subtracted). Sessions left running in
  tmux otherwise inflate duration. Independent of full-content chunks (uses the
  existing per-event timestamps). **Done**: `activeMs` is computed per session and
  shown on the session detail; the list stays wall-clock at Tier-1 volumes, since it
  needs a per-session scan.
- **Combined-prompt provenance** *(nice-to-have, Tier 2/3)* — for each session,
  record and visualise the effective combined prompt (system prompt + CLAUDE.md
  layers + memory + appended instructions) so it's clear which instructions, and
  from where, applied to every message.
- **Self-built CouchDB migrations** — **done** for schema/views: a versioned up/down
  engine with a marker doc, driven from the CLI and `/api/migrate/*`; eight migrations
  applied to date ([migrations.md](../operate/migrations.md),
  [ADR 0021](decisions/0021-self-built-couchdb-migrations.md)). The export/import
  **bundle** format is built on top of it ([bundles.md](bundles.md)). Remaining:
  document-transforming migrations themselves, and the scoped replay import needs before
  a bundle can cross one — see [Tier 1 — open work](#tier-1--open-work).

**Ingest & lifecycle (Tier 1/2)**
- `backfill` — **done**: adopts this machine's history as first-class records
  (summary + per-event docs + full-content chunk docs, transcript to S3), delivered
  through the webapi's ingest routes so it lands indexed
  ([tools.md](../operate/tools.md)) (#6). Remaining: a re-process path — see
  [Tier 1 — open work](#tier-1--open-work).
- Full Claude Code hook-type coverage + drift check ([hooks.md](../reference/hooks.md), #5/#13)

**Quality (Tier 1 → Tier 2 gate)**
- **End-to-end test suite** — **done**: fakes CC sessions and drives the whole
  write→store→read path through the real gateway, asserting rollups, token usage,
  status, and both transcript sources ([testing.md](../develop/testing.md)). Remaining:
  fixture teardown — see [Tier 1 — open work](#tier-1--open-work).

**Search & recall (Tier 2)**
- Meilisearch search — **done**: `GET /api/search` returns both **session-metadata**
  hits (cwd, model, tools, host — `sessions` index) and **conversation-content** hits
  (turn text with cropped snippets — `turns` index over `chunk.entries[]`). The webui
  header search box shows both, live + best-effort (degrades gracefully when Meili is
  down/disabled). Indexes stay current via a **CouchDB `_changes` follower**, so docs
  written outside the ingest endpoints — the hook writes straight to CouchDB — are
  indexed without manual intervention; `POST /api/search/reindex` (`cli reindex`)
  rebuilds from CouchDB and is the reconciliation step for deletes and for history
  predating search. Remaining: typeahead ranking, filters, a dedicated results page,
  coverage for running sessions, and a vector index for agent retrieval
  ([database-choice.md](database-choice.md)) (#9) — the near-term ones are in
  [Tier 1 — open work](#tier-1--open-work); whether Meilisearch may live **outside**
  the bundled stack is [ADR 0028](decisions/0028-external-vs-bundled-meilisearch.md).
- Claude Code recall plugin ([tiers.md](tiers.md) → T2) (#10)

**Webui (Tier 2)**
- Configurable session-list columns + virtual scroll (#8)
- Config-driven services menu — **done**: `servicesMenu` flows from `config/` through
  the app model into the `/` manifest and the webui's Links menu, so admin-UI links
  follow a deployment's real hosts/ports ([routes.md](../reference/routes.md)) (#14)
- **Claude Code statusline indicator** — show a statusline in Claude Code when the
  external transcripts store is connected and logging, giving live confirmation the
  hook is wired.

**Tier 3 — multiplayer & public release**
- Masterless replication + auth/security ([tiers.md](tiers.md), [ADR 0015](decisions/0015-tiered-architecture.md))
- Static-HTML docs in the combined image ([containers.md](../operate/containers.md))
- **Scheduled-task service** — lightweight FOSS "functions" for stats / summaries /
  anomaly detection over the corpus ([tiers.md](tiers.md))
- **Session export to PDF / Markdown / JSON** ([tiers.md](tiers.md))
- Extensibility & bundled tooling (OpenHack, Fossil, integration points)

> Earlier "consider" issues, now noted here: codebase search (#1). Logging CC web
> traffic (#2) is promoted to "Claude Code API traffic capture" above.

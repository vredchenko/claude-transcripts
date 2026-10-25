# RFC: The webapi as the only writer, required backing services, and how it ships

Date: 2026-10-18

## Status

Proposed (2026-10-18). Nothing is built. The parts carry different weight:

| Part | Status |
|---|---|
| [1. The hook writes through the webapi](#1-the-hook-writes-through-the-webapi) | Proposed, leaning accept |
| [2. Backing services are required](#2-backing-services-are-required-bundled-or-external-is-only-a-url) | Proposed, leaning accept |
| [3. Outages become incidents, and incidents get repaired](#3-outages-become-incidents-and-incidents-get-repaired) | Proposed, open |
| [4. Projections: derived stores behind ports](#4-projections-derived-stores-behind-ports) | Proposed, open |
| [5. The app distributes its own clients](#5-the-app-distributes-its-own-clients) | Proposed, open |
| [6. Fossil sits behind the webapi](#6-fossil-sits-behind-the-webapi) | Proposed, open |
| [7. One release pipeline, three targets: omni, compose and Helm](#7-one-release-pipeline-three-targets-omni-compose-and-helm) | Proposed, open (added 2026-10-25) |
| [8. A live event stream from the webapi](#8-a-live-event-stream-from-the-webapi) | Proposed, open (added 2026-10-25) |
| [9. Consider rewriting the webapi in Elixir](#9-consider-rewriting-the-webapi-in-elixir) | To consider (added 2026-10-25) |
| [10. Several Claude Code plugins writing to one backend](#10-several-claude-code-plugins-writing-to-one-backend) | Proposed, open (added 2026-10-25) |
| [11. Configurable ingest routing and multiple backends](#11-configurable-ingest-routing-and-multiple-backends-an-idea) | Idea (added 2026-10-25) |

If parts 1 and 2 are accepted, they become one ADR that supersedes the
[ADR 0016 amendment](../docs/design/decisions/0016-webapi-is-the-io-gateway.md#amendment-the-hook-is-a-second-writer)
and the optionality in [ADR 0015](../docs/design/decisions/0015-tiered-architecture.md)
and [ADR 0028](../docs/design/decisions/0028-external-vs-bundled-meilisearch.md). Parts 3–11
would each get an ADR of their own.

Parts 7–11 all lean on parts 1 and 2: once every write goes through the webapi, it's the
one place to package (7), to stream from (8), to rewrite (9), to accept many writers at
(10), and to route writes from (11).

## Context

The stack was designed to be modular: almost every piece could be left out, and every
backing service could be bundled or external. As of 0.6.2 that looks like this:

| Component | Today | Where that's decided |
|---|---|---|
| webapi | Required. The gateway for every read and every consumer write. | ADR 0015, ADR 0016 |
| webui | Ships in the same image and process as the webapi. "Optional" only means you don't have to open it. | ADR 0002 |
| CouchDB | Required. Bundled or external. | ADR 0015, ADR 0020 |
| S3 (Garage) | "Optional" behind `features.s3Blobs`. In practice required: it's the only durable home of transcript bytes. | ADR 0014 |
| Meilisearch | Optional behind `features.meilisearch`. Bundled, or external and namespaced. | ADR 0009, ADR 0028 |
| The hook | The CLI (`claude-transcripts hook run`). The plugin's `dispatch.ts` is a thin shim to it. It writes **directly** to CouchDB and S3, and fans out to any configured mirrors. | ADR 0004 amendment, ADR 0016 amendment |
| The plugin | The hooks (the write entry point), plus the read-side skills, the statusline and `/status`. Its skills shell out to the CLI, which reads through the webapi. | — |
| The CLI | Installed from release assets by `install.sh`. | ADR 0012 |

So "the webapi is the gateway" is already the rule. The hook is the exception, and
most of the remaining edge cases come from it:

- **Two write paths.** The hook writes to the stores; backfill, import and every
  other consumer write through `/api/ingest/*`. Same documents, two code paths.
- **No write-time validation for hook-written docs.** That's why the `_changes`
  follower carries more than indexing.
- **Every hook machine needs store credentials and endpoints**: a CouchDB URL, an S3
  endpoint, keys, a bucket, plus a list of mirrors. A multi-machine deploy hands
  storage credentials to every workstation.
- **The hook knows the topology.** Mirrors, per-store health (`StoreHealth` in
  `packages/cli/src/hook/runtime.ts`), and which store the statusline's label names
  are all hook concerns today.
- **Configuration permutations.** Two feature flags guard services that are, in
  practice, always on. Each flag doubles the matrix nobody tests.

The aim here is fewer moving parts and fewer edge cases: one door in and out, with the
stores encapsulated behind it.

## Proposal

### 1. The hook writes through the webapi

The hook stops talking to CouchDB and S3. It calls the same `/api/ingest/*` endpoints
that `backfill` already uses (`packages/webapi/src/routes/ingest.ts`). Those are
idempotent already: summaries upsert, and chunks and events have stable ids, so a
conflict is treated as already present. The hook's configuration shrinks to a webapi
URL, plus a token once Tier 3 adds auth.

**Why the bypass existed, and why it no longer pays for itself.** The amendment to ADR
0016 made the hook a second writer so that a webapi outage couldn't lose a session.
That rested on the webapi being more likely to fail than the stores. It isn't
meaningfully more likely. It's our code rather than a mature project's, but it's a thin
layer, and when CouchDB is down today the direct write fails just the same. Write
failures already happen, and there's already a recovery mechanism for them.

**No local spool.** An earlier draft of this idea proposed a store-and-forward outbox on
the hook's machine: payloads queued on disk when the webapi doesn't answer, then
replayed. It isn't needed, because the outbox already exists. Claude Code keeps every
session's transcript as JSONL under `~/.claude/projects/`, and
`claude-transcripts backfill --repair` re-derives the summary, events, chunks and blob
from it. A missed write is therefore never lost while the transcript is still on disk.
What the hook needs to keep isn't the payload. It's **the fact that it missed one** (see
part 3).

The one real limit is time: Claude Code prunes old transcripts (`cleanupPeriodDays`,
30 days by default). Repair has to happen inside that window, which is what part 3 is
for.

**Transcript upload.** The SessionEnd blob upload streams through the webapi
(`/api/ingest/{id}/transcript`) instead of going straight to S3. On a local stack the
extra hop is negligible. Against a remote webapi it counts against Claude Code's
60-second SessionEnd budget, as the direct S3 upload does now. Presigned S3 URLs handed
out by the webapi are the fallback if that turns out to be tight, at the cost of
requiring that the hook can reach S3.

**Load** isn't a concern at this scale: a hook writes a handful of small documents per
turn. If it ever becomes one, the webapi is stateless and can be scaled horizontally.

**Short-outage buffering in the webapi** (optional, later). The webapi could hold
accepted writes in memory for a short grace period while a store is unreachable, then
flush them or give up and report. It's best-effort only: a webapi restart drops the
buffer, and repair remains the safety net. An Elixir/BEAM webapi would make this
natural; part 9 weighs that against the shared TypeScript it would split.

### 2. Backing services are required; bundled or external is only a URL

CouchDB, S3 and Meilisearch become hard dependencies. `features.s3Blobs` and
`features.meilisearch` are removed, along with the code paths that run without them.
Each service is still bundled or external (ADR 0020, ADR 0028); the webapi just points at
it.

"Required to deploy" isn't the same as "on the critical path". At runtime:

| Down | Effect |
|---|---|
| CouchDB | Ingest and most reads fail. The webapi answers `503` with a machine-readable reason naming the store; the statusline shows it. |
| S3 | Blob uploads fail. Transcript reads still mostly work from chunk docs (ADR 0027). Reported the same way. |
| Meilisearch | `/api/search` answers `503`. Everything else works: **required but degradable**. |

The statusline's health model collapses from per-store to one question: did the webapi
accept the write, and if it didn't, what did it say? `StoreHealth` and the mirror
labels go.

### 3. Outages become incidents, and incidents get repaired

When a write fails, record it, so the gap isn't forgotten once the statusline goes green
again. Two places can detect a failure:

- **The webapi** sees a store fail: CouchDB, S3 or Meilisearch. It records an incident
  (which store, which sessions, the time window) in Fossil, which has tickets natively and
  is meant for exactly this kind of internal Tier 2 state.
- **The hook** sees the webapi fail. It can't reach Fossil either, so it writes a small
  local marker (`session_id`, first and last failure time, last error) under `$CT_HOME`
  and files it as an incident on the next successful contact. This is a few bytes per
  session, not a payload spool.

Then the loop closes:

1. **SessionStart** asks the webapi for open incidents affecting this host.
2. It runs the repair (`backfill --repair` scoped to those sessions), or, if repair can't
   run unattended, it tells the user in the session-start context and the statusline.
3. A successful repair closes the incident.

Open questions:
- Fossil tickets or append-only CouchDB docs? Fossil is the better fit for "internal
  tracked state", but when CouchDB is the failing store, CouchDB is the wrong place to
  record the incident. If Fossil is down too, the local marker is the fallback.
- Repair on SessionStart has to fit the hook's time budget. It may need to be detached,
  like the SessionEnd upload already is.
- Incidents older than the transcript cleanup window can't be repaired. They should
  close as `unrecoverable` rather than stay open forever.

### 4. Projections: derived stores behind ports

Meilisearch is a **projection**: derived from CouchDB, rebuildable and disposable. Make
that a first-class concept rather than a special case. Each projection has:

- a `_changes` consumer with its own checkpoint;
- `ensure()` (schema or settings), `rebuild()` (drop and replay) and `health()`;
- a **port** the webapi routes call, with the engine as an adapter. `/api/search` calls
  a `SearchPort`, and Meilisearch is its first adapter, so the engine can be swapped
  without changing the contract.

The blueprint gets a `projections` map beside `couchdb.databases` and `s3.buckets`, and
compose and the Kubernetes base project from it. Candidates for later projections: DuckDB
for analytics (see the [storage evaluation](2026-09-12-storage-backend-evaluation.md),
Part 5), and a graph store. Projections are never written by consumers and never
authoritative: losing one costs a rebuild, not data.

### 5. The app distributes its own clients

The webapi serves the CLI binaries, the plugin and the installer from its own origin
(something like `/dist/*`). With lockstep versions
([ADR 0023](../docs/design/decisions/0023-lockstep-versioning-and-combined-image.md)), the
installed client always matches the server it was fetched from, and onboarding is one
URL: fetch the installer from the instance, and it installs the CLI, registers the plugin
and writes that instance's webapi URL. It also suits deploys from a private forge or
registry, where release assets on a public host aren't the natural source.

Costs and unknowns:
- The image grows by one compiled binary per platform. Per-arch images could carry only
  their own binary and point at release assets for the others.
- Whether a Claude Code plugin marketplace can be served from an arbitrary HTTP origin
  hasn't been checked.

### 6. Fossil sits behind the webapi

Fossil holds internal Tier 2 state, never session-log data. It stays behind the webapi
like the other stores, which matches today's read-only proxy
([ADR 0031](../docs/design/decisions/0031-fossil-as-bundled-infrastructure.md)). Writes
would go through curated endpoints, as for CouchDB. Whether `fossil clone` / `sync` ever
needs a passthrough is left until something needs it.

### 7. One release pipeline, three targets: omni, compose and Helm

One pipeline builds the component images once and releases them in three shapes. Every
shape is built from the same images, so none can drift from the others:

| Target | What it is | For |
|---|---|---|
| **omni** | One container image: every service under s6-overlay, one volume, one port | A single Docker box, Unraid, Synology: `docker run` and done |
| **compose** | Today's compose project: one container per service | Anyone with Compose who wants per-service limits and upgrades |
| **Helm** | A chart (or another package Kubernetes and Argo CD deploy natively) | Clusters, GitOps |

Today there's the compose project and a generated kustomize base
([ADR 0030](../docs/design/decisions/0030-kubernetes-deploy-generated-from-the-model.md)).
Argo CD already deploys kustomize, so the question for the third target is whether a Helm
chart earns its place. It probably does: the include options below are exactly what Helm
values are for, where kustomize would need a component per option. Either way it's
**generated from the blueprint**, like compose and the kustomize base are now. It isn't
hand-written.

#### Include options

Every target takes the same switches, projected from the blueprint:

| Option | Default | Notes |
|---|---|---|
| Garage UI | off | An admin convenience; the data is reachable through the webui and the read proxies |
| Meilisearch UI | off | Meilisearch serves its own UI on its main port |
| Bundled web docs | on | The rendered docs the webapi serves at `/docs` (`CT_DOCS_DIR`); off for a smaller image when the public docs site is enough |
| Each backing service: bundled or external | bundled | Unchanged (ADR 0020, ADR 0028). External means the target omits the container and takes a URL |

In compose they're profiles. In Helm they're values. In omni they're build arguments for a
variant image, or a runtime switch that just doesn't start the service.

The webapi, webui and CLI stay **separate artifacts**. Folding all three into one binary
(the `serve` proposal, #224) is a premature decision. Nothing in these targets needs it,
and it couples three release cadences before there's a reason to.

#### The omni image

**Non-goals:** horizontal scaling or HA (one container, one node); replacing compose or
Helm; per-service resource isolation (an accepted trade-off).

| Service | Role | How it gets into the image |
|---|---|---|
| CouchDB | System of record | The base image: an Erlang release plus system libraries, the hardest piece to transplant |
| Garage | S3 blobs | `COPY --from` the upstream image: a static Rust binary |
| Meilisearch | Search projection | The release binary. Check musl vs glibc against the Debian base |
| Fossil | Internal Tier 2 state | A static C binary, built in a builder stage |
| webapi + webui (+ docs, optional) | The single public entry point | Built in its own stage and copied in |
| Garage UI, Meilisearch UI | Optional admin UIs | Only when their option is on |
| s6-overlay | PID 1, supervision, init ordering | Upstream tarballs |

How it fits the rest of this RFC:

- **One port, served by the webapi.** Every other service binds to `127.0.0.1` inside the
  container. That's parts 1 and 6 made physical: there's no other door. The webapi
  already serves the SPA, the docs and the read proxies, so it's the router. Caddy only
  comes back if TLS termination inside the container is wanted.
- **Fossil is internal only.** No direct HTTP sync, per part 6.
- **Required services** (part 2). The image always contains all four stores.
- **One health check.** A single `HEALTHCHECK` hits a webapi endpoint that checks CouchDB,
  Garage, Meilisearch and Fossil and reports per-service status. It's the same
  machine-readable, per-store `503` reason part 2 gives the statusline.
- **Meilisearch upgrades become a rebuild.** A Meilisearch major version needs a dump and
  import, which users who never read release notes will miss. As a projection (part 4) the
  index can simply be dropped and rebuilt from CouchDB on first boot of a new version.
- **The image distributes its own clients** (part 5). Onboarding a workstation is one URL
  against the one port.

One volume at `/data`:

```
/data
  couchdb/
  garage/meta/
  garage/data/
  meilisearch/
  fossil/
  secrets/        # generated on first boot
```

Services under `/etc/s6-overlay/s6-rc.d/`:

- `init-firstboot` (oneshot): runs only when `/data` is empty or a marker file is missing.
- `couchdb`, `garage`, `meilisearch`, `fossil` (longrun), each with a readiness check
  (s6 notification or a polling script) so nothing races the Erlang VM.
- `init-provision` (oneshot): waits for the four services, then does the idempotent setup
  that needs running daemons.
- `webapi` (longrun): depends on `init-provision`.

**Failure policy:** if a core service dies repeatedly, stop the container
(`S6_BEHAVIOUR_IF_STAGE2_FAILS=2` or a finish script), so the host's restart policy and
monitoring notice, rather than limping along half-dead.

**Provisioning**, idempotent and safe to re-run on every start:

- **CouchDB:** admin credentials and the `_users` and `_replicator` system databases. The
  webapi's boot `ensure` already creates the app databases.
- **Garage:** `garage layout assign` and `garage layout apply` for the single node (Garage
  serves nothing until a layout exists); an access key; the buckets.
- **Meilisearch:** the master key. Indexes and settings come from the webapi's `ensure`.
- **Fossil:** initialise the repository (today's `deploy/fossil/entrypoint.sh` seed).
- **webapi:** receives all of the above as environment variables or secrets files.

**Configuration:** environment variables only, all optional, with sane defaults, every one
documented with its default. This sits against
[ADR 0020](../docs/design/decisions/0020-bundled-services-default-no-auth.md) (bundled
services default to no auth): inside the container nothing but the webapi is reachable, so
no-auth stays safe. Where a service insists on a credential (Garage keys, the Meilisearch
master key in production mode), generate it on first boot and persist it under
`/data/secrets`, so restarts and upgrades keep working.

**Upgrade:** pull the new tag and recreate the container; provisioning re-runs. Release
notes call out any component migration that rebuilding can't cover. **Backup:** stop the
container and copy `/data`. A `backup` command that dumps consistently while running is
optional.

**Trade-offs:** one health check surface for five processes; every component upgrades in
lockstep; a shared memory budget with no per-service limits; a larger image than any
single component.

#### The pipeline

- **Build once:** one image per component, multi-stage, every upstream pinned by tag and
  digest, `linux/amd64` and `linux/arm64` (check each upstream binary exists for both;
  build Fossil and the webapi per arch). The omni image is assembled from those images
  rather than built separately.
- **Release three shapes:** the omni image (plus its option variants, if options are build
  time), the compose files, and the chart, all versioned together.
- **Test each shape:** start it on empty storage, wait for healthy, run the e2e smoke
  tests. For omni, a second start on the same volume proves idempotent restart, and an
  upgrade test starts the new image on the previous release's volume. For Helm, install
  into a throwaway cluster (kind or k3d) in CI.

Open questions:
- Helm, or keep kustomize and add components for the options?
- Are omni's options build time (variant tags) or runtime (one image, services skipped)?
  Runtime is simpler to publish; build time gives smaller images.
- The minimum memory to document for omni.
- Whether every shape tracks the app's lockstep version (ADR 0023), given that an upstream
  security fix in one component would otherwise force an app release.

### 8. A live event stream from the webapi

The webapi publishes what changes as a stream that clients subscribe to. The webui uses it
to update in real time: new sessions appear in the list, a live session's transcript grows,
status turns from live to ended or stalled. Nothing has to poll. In Tier 3, other users
subscribe to the same stream: a teammate watching a session, a dashboard, an agent
reacting to events.

**Source.** The webapi already follows CouchDB's `_changes` feed
(`packages/webapi/src/storage/changes-follower.ts`) for the session index and search. The
stream is one more consumer of that feed. Because every write goes through the webapi
(part 1) and the feed is ordered, the stream sees every write exactly once and in order,
whichever writer made it.

**Mechanism.**

- **Transport:** WebSockets, with Server-Sent Events as the fallback for read-only
  subscribers behind proxies that break upgrades. Both carry the same messages.
- **Topics:** `sessions` (created, updated, ended, stalled), `session:<id>` (new turns and
  events for one session), `incidents` (part 3), `health` (per-store status, part 2). A
  client subscribes to topics with optional filters (host, project), so the webui's list
  view and a detail view take only what they show.
- **Resume:** each message carries the CouchDB sequence it came from. A reconnecting client
  sends its last sequence and gets everything since, so a dropped connection loses nothing
  and the client never needs a full refetch.
- **Backpressure:** a slow subscriber gets coalesced updates ("session X changed",
  refetch it) rather than an unbounded buffer, and is dropped past a limit. It can always
  resume.
- **Contract:** messages are typed in shared code and described alongside the OpenAPI
  spec (AsyncAPI is the usual format for that), so clients are generated, not hand-written,
  like the REST ones.
- **Auth:** none in Tier 1, like the rest of the API. In Tier 3 subscriptions go through
  the same single choke point (part 1), and topics are filtered by what the subscriber may
  see.

The blueprint gets a `channels` map (topic, payload schema, source), so the webui, the CLI
and the docs project from it like everything else.

### 9. Consider rewriting the webapi in Elixir

To consider, not decided. Several parts of this RFC are things the BEAM does natively:

- **The event stream** (part 8): Phoenix Channels and Phoenix.PubSub are exactly topics,
  fan-out, presence and reconnect, distributed across nodes for free.
- **Short-outage buffering** (part 1): per-store supervised processes that hold accepted
  writes and retry, restarting cleanly when they crash.
- **Ingest routing** (part 11): a supervision tree per backend, each failing on its own
  without taking the others down.
- **Many concurrent writers** (part 10): cheap processes per connection.

The cost is the isomorphic TypeScript. Today the blueprint, the doc types and the
validators are shared by the webapi, webui and CLI. A rewrite keeps the **OpenAPI spec (and
the AsyncAPI spec) as the contract**, so the webui and CLI keep generated clients and don't
notice. But the blueprint and validators would need a language-neutral source, such as
JSON Schema generated from the TypeScript or the other way round, or they'd exist twice.
The hook stays in TypeScript either way: it lives in the CLI.

A way to find out without committing: build part 8's stream as a small Elixir service
beside the TypeScript webapi, consuming the same `_changes` feed. If that's where the
pleasure and the reliability are, move the rest over endpoint by endpoint behind the same
contract.

### 10. Several Claude Code plugins writing to one backend

Today one plugin (ours) writes, and lockstep versioning assumes its version matches the
server's. The backend should accept writes from **several writers at once**: many
machines and users, plugin versions that lag the server, and other Claude Code plugins that
want to record into the same store (a team plugin, a plugin for another agent).

- **Writer identity:** every ingest call says who wrote it: plugin id, plugin version,
  machine and, in Tier 3, user. It's stored on the docs, so provenance survives (today's
  `source` field is the start of this).
- **A compatibility window:** the ingest contract is versioned, and the webapi accepts the
  current and previous version(s) rather than demanding lockstep. An older plugin keeps
  recording; the statusline says it's out of date.
- **Namespaces:** a third-party plugin writes under its own namespace and schema, validated
  at the webapi (part 1 makes that possible: every write is seen). It can't touch another
  writer's docs.
- **Idempotency across writers:** ids are already stable per session, chunk and event. Two
  plugins recording the same session need distinct ids or an explicit merge rule; decide
  which.

### 11. Configurable ingest routing and multiple backends (an idea)

Just an idea for now. The webapi decides **where** each write goes, and a store can be more
than one backend:

- **Routing by store:** which CouchDB database and which S3 bucket each kind of write lands
  in is configuration, not code. That already holds for names (`couchdb.databases`,
  `s3.buckets` are keyed maps built for more than one); extend it to whole instances.
- **Several backends per store:** for example omni's bundled CouchDB plus an external
  CouchDB, both written; the same for S3 (bundled Garage plus an external bucket). One is
  **primary**: writes must land there, and reads come from it. The others are
  **secondaries**: written best-effort, and a failure there is an incident (part 3), not a
  failed write.
- **Policies, per store:** `primary-only`, `all` (fail if any fails), `primary + async
  secondaries`. Possibly per database, so app logs could go only to the external one.
- **Why it's cheap here:** documents are append-only and immutable, so writing the same
  doc to two CouchDB instances can't conflict. A secondary that missed writes is caught up
  by replication or by repair.

This is where the hook's mirror fan-out goes (see Interactions): the same capability,
moved to the server, configured once.

### Considered and dropped

- **A local payload spool on the hook machine.** The transcript on disk already is one
  (part 1).
- **Graylog** for log streams. Too heavy for what it buys: it brings OpenSearch and
  MongoDB with it. App logs already go to CouchDB (ADR 0018). If a log sink becomes
  pluggable later, emitting OpenTelemetry is the abstraction to reach for.
- **Valkey** as a cache. Not until something actually needs one.
- **One binary for the webapi, webui and CLI** (`serve`, #224). Premature: nothing in the
  release targets (part 7) needs it, and it ties three release cadences together before
  there's a reason to. Revisit if a target ever does.

## Interactions

- **[Embedded mode](2026-10-15-embedded-mode-single-binary.md).** That RFC keeps the
  hook writing directly to SQLite, so it stays independent of the webapi being up. This
  RFC removes that independence. If both are accepted, embedded mode either runs the
  webapi as a long-lived local process the hook calls, or keeps a direct in-process
  write as its own documented exception. Decide that explicitly; don't let it fall out
  of whichever lands second. Embedded mode and the omni image (part 7) answer the same
  need, one thing to run on one box, in two ways: a single binary over SQLite, or a single
  container over the real stores. Choosing one doesn't rule out the other, but they
  shouldn't both be built before one has proved it's wanted. Embedded mode also takes
  `serve` (#224) as its first step, which this RFC drops as premature; if embedded mode
  goes ahead, that step comes back with it.
- **Mirrors.** The hook's fan-out to several CouchDB instances goes away. It becomes
  part 11: the webapi writes to a primary and any secondaries, configured once on the
  server, not per workstation. Reporting into a shared instance is a secondary, CouchDB
  replication behind the webapi, or one webapi forwarding to another.
- **The event stream and the change follower.** Part 8 is a third consumer of the same
  `_changes` feed as the session index and search. If parts 4 and 8 are both accepted, the
  stream is best modelled as a projection whose "store" is the set of live subscribers.

## Consequences

If parts 1 and 2 are accepted:

- **Deleted:** the hook's CouchDB and S3 clients, mirror fan-out and per-store health;
  the two feature flags and their no-S3 / no-search code paths; the "hook-written docs
  get no validation" caveat.
- **The `_changes` follower** stays, but only to feed projections.
- **Hook configuration** is a webapi URL. No store credentials leave the server.
- **Docs to update:** ADR 0016 (the amendment is superseded), ADR 0015 (the optional
  list), ADR 0028, the architecture diagram's write lane, and the "Key invariants" in
  `CLAUDE.md`.
- **Tier 3 auth** gets a single choke point.

If part 7 is accepted:

- **New:** the omni Dockerfile, its s6 service tree and provisioning scripts; a Helm chart
  (or kustomize components) generated from the blueprint; include options in the
  blueprint, projected into compose profiles, chart values and omni; a webapi health
  endpoint that reports per store; a release workflow and CI tests for all three shapes.
- **Changed:** the admin UIs become opt-in in compose and Kubernetes too, and the bundled
  docs become optional in the app image.
- **Docs to update:** installation (a `docker run` path and a Helm path), the deploy
  README, ADR 0030, and ADR 0023 if the shapes are versioned separately.

If part 8 is accepted: a stream endpoint in the webapi, a `channels` map in the blueprint,
a generated client, and the webui moving from refetching to subscribing.

Parts 9–11 are exploratory; their consequences are written when one becomes a proposal.

## Terms

Used above, collected for anyone new to the vocabulary:

- **Backing service / attached resource** — a store the app uses over the network,
  addressed by URL ([12-factor](https://12factor.net/backing-services)). "Bundled or
  external" is *managed vs bring-your-own*.
- **System of record** — the authoritative store (CouchDB, plus S3 for raw bytes). The
  webapi isn't one; it's the **gateway** or **facade**: the single entry point and the
  contract.
- **Projection / read model / derived store** — state computed from the system of
  record, rebuildable from it (Meilisearch).
- **Port and adapter** — an interface the app depends on (the port) with a swappable
  implementation behind it (the adapter). Also called hexagonal architecture.
- **Store-and-forward / outbox** — queue a write locally, deliver it later. Dropped here
  because the transcript already plays that role.
- **Idempotent** — safe to repeat: a replayed write is a no-op.
- **Hard dependency, required but degradable** — must exist for the app to deploy, but
  its outage disables one feature rather than the app.

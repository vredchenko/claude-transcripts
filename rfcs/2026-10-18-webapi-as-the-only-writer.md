# RFC: The webapi as the only writer, required backing services, and an all-in-one image

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
| [7. Community Edition: an all-in-one image](#7-community-edition-an-all-in-one-image) | Proposed, open (added 2026-10-25) |

If parts 1 and 2 are accepted, they become one ADR that supersedes the
[ADR 0016 amendment](../docs/design/decisions/0016-webapi-is-the-io-gateway.md#amendment-the-hook-is-a-second-writer)
and the optionality in [ADR 0015](../docs/design/decisions/0015-tiered-architecture.md)
and [ADR 0028](../docs/design/decisions/0028-external-vs-bundled-meilisearch.md). Parts 3–7
would each get an ADR of their own.

Part 7 is a distribution format rather than an architecture change. It's here because it
only works cleanly on top of the rest: one door in (parts 1 and 6), every service present
(part 2), and a search index that can be rebuilt rather than migrated (part 4).

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
buffer, and repair remains the safety net. An Elixir/BEAM rewrite of the webapi would
make this natural, but it's out of scope here: the webapi shares its blueprint, types
and validators with the webui and CLI as isomorphic TypeScript, and a second language
would split that.

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

### 7. Community Edition: an all-in-one image

Ship the Community Edition as **one Docker image**: a single `docker run`, one volume, one
port. No compose file, no orchestration knowledge. Target hosts are a single Docker box,
Unraid, Synology and the like. Today the bundled stack is a compose project of six or more
containers (CouchDB, Garage, Garage UI, Meilisearch, Meilisearch UI, Fossil) around the
combined app image ([ADR 0023](../docs/design/decisions/0023-lockstep-versioning-and-combined-image.md)).

This is a distribution format, not the reference architecture. Multi-container deploys
(compose, and the [Kubernetes base](../docs/design/decisions/0030-kubernetes-deploy-generated-from-the-model.md))
stay the reference, and the compose file stays published: it's nearly as simple for
anyone who has Compose, and it avoids the trade-offs below. Both are built from the same
component images, so they can't drift.

**Non-goals:** horizontal scaling or HA (one container, one node); replacing the
multi-container deploys; per-service resource isolation (an accepted trade-off).

#### What goes in

| Service | Role | How it gets into the image |
|---|---|---|
| CouchDB | System of record | The base image: an Erlang release plus system libraries, the hardest piece to transplant |
| Garage | S3 blobs | `COPY --from` the upstream image: a static Rust binary |
| Meilisearch | Search projection | The release binary. Check musl vs glibc against the Debian base |
| Fossil | Internal Tier 2 state | A static C binary, built in a builder stage |
| webapi (+ webui, docs) | The single public entry point | Built in its own stage and copied in. The `serve` binary (#224) makes this one file |
| s6-overlay | PID 1, supervision, init ordering | Upstream tarballs |

The admin UIs (Garage UI, Meilisearch UI) are left out. Their data is already reachable
through the webui and the webapi's read proxies.

#### How it fits this RFC

- **One port, served by the webapi.** Every other service binds to `127.0.0.1` inside the
  container. That's parts 1 and 6 made physical: there's no other door. The attached scope
  left "webapi or Caddy in front?" open; with this RFC the answer is the webapi, which
  already serves the SPA, the docs and the read proxies. Caddy only comes back if TLS
  termination inside the container is wanted.
- **Fossil is internal only.** No direct HTTP sync, per part 6.
- **Required services, no flags** (part 2). The image always contains all four stores, so
  there is no permutation to test.
- **One health check.** A single `HEALTHCHECK` hits a webapi endpoint that checks CouchDB,
  Garage, Meilisearch and Fossil and reports per-service status. It's the same
  machine-readable, per-store `503` reason part 2 gives the statusline.
- **Meilisearch upgrades become a rebuild.** A Meilisearch major version needs a dump and
  import, which users who never read release notes will miss. As a projection (part 4) the
  index can simply be dropped and rebuilt from CouchDB on first boot of a new version.
- **The image distributes its own clients** (part 5). Onboarding a workstation is one URL
  against the one port.

#### Layout, supervision and first boot

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

- **CouchDB:** admin credentials; the `_users` and `_replicator` system databases; the app
  databases. The webapi's boot `ensure` already creates the app databases, so this step
  only needs the system ones.
- **Garage:** `garage layout assign` and `garage layout apply` for the single node (Garage
  serves nothing until a layout exists); an access key; the buckets.
- **Meilisearch:** the master key; indexes and settings (again the webapi's `ensure`).
- **Fossil:** initialise the repository (today's `deploy/fossil/entrypoint.sh` seed).
- **webapi:** receives all of the above as environment variables or secrets files.

#### Configuration

Environment variables only, all optional, with sane defaults, every one documented with
its default. This sits against [ADR 0020](../docs/design/decisions/0020-bundled-services-default-no-auth.md)
(bundled services default to no auth): inside the container nothing but the webapi is
reachable, so no-auth stays safe. Where a service insists on a credential (Garage keys,
the Meilisearch master key in production mode), generate it on first boot and persist it
under `/data/secrets`, so restarts and upgrades keep working.

#### Build, upgrade, backup and testing

- **Build:** a multi-stage Dockerfile, one builder stage per component, final stage on the
  CouchDB image. Every upstream pinned by tag and digest. `linux/amd64` and `linux/arm64`:
  check each upstream binary exists for both, and build Fossil and the webapi per arch.
- **Upgrade:** pull the new tag and recreate the container; provisioning re-runs. Release
  notes call out any component migration that rebuilding can't cover.
- **Backup:** stop the container and copy `/data`. Document it. A `backup` command that
  dumps consistently while running is optional.
- **CI:** build the image, start it on an empty volume, wait for healthy, run the e2e smoke
  tests against the one port. A second run on the same volume proves idempotent restart.
  An upgrade test starts the new image on the previous release's volume.

#### Trade-offs

- One health check surface for five processes.
- Every component upgrades in lockstep.
- A shared memory budget with no per-service limits.
- A larger image than any single component.

Open questions:
- The minimum memory to document for the whole bundle.
- Whether the image tracks the app's lockstep version (ADR 0023) or has its own, given that
  an upstream security fix in one component would otherwise force an app release.

### Considered and dropped

- **A local payload spool on the hook machine.** The transcript on disk already is one
  (part 1).
- **Graylog** for log streams. Too heavy for what it buys: it brings OpenSearch and
  MongoDB with it. App logs already go to CouchDB (ADR 0018). If a log sink becomes
  pluggable later, emitting OpenTelemetry is the abstraction to reach for.
- **Valkey** as a cache. Not until something actually needs one.

## Interactions

- **[Embedded mode](2026-10-15-embedded-mode-single-binary.md).** That RFC keeps the
  hook writing directly to SQLite, so it stays independent of the webapi being up. This
  RFC removes that independence. If both are accepted, embedded mode either runs the
  webapi as a long-lived local process the hook calls, or keeps a direct in-process
  write as its own documented exception. Decide that explicitly; don't let it fall out
  of whichever lands second. Embedded mode and the all-in-one image (part 7) answer the
  same need, one thing to run on one box, in two ways: a single binary over SQLite, or a
  single container over the real stores. Choosing one doesn't rule out the other, but they
  shouldn't both be built before one has proved it's wanted.
- **`serve` (#224).** Folding the webapi, webui and docs into the CLI binary turns the
  webapi into one file to copy into the image. Part 7 doesn't need it, but it's simpler
  with it.
- **Mirrors.** The hook's fan-out to several CouchDB instances goes away. Reporting into
  a shared instance becomes either CouchDB replication behind the webapi, or the webapi
  forwarding to another webapi. Either way it's a server concern, configured once, not
  per workstation.

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

- **New:** an all-in-one Dockerfile, its s6 service tree and provisioning scripts, a
  webapi health endpoint that reports per store, and a CI job for the image.
- **Kept:** the compose file and the Kubernetes base, built from the same component
  images.
- **Docs to update:** installation (a single `docker run` path), the deploy README, and
  ADR 0023 if the image is versioned on its own.

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

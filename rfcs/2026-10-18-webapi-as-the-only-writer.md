# RFC: The webapi as the only writer, and required backing services

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

If parts 1 and 2 are accepted, they become one ADR that supersedes the
[ADR 0016 amendment](../docs/design/decisions/0016-webapi-is-the-io-gateway.md#amendment-the-hook-is-a-second-writer)
and the optionality in [ADR 0015](../docs/design/decisions/0015-tiered-architecture.md)
and [ADR 0028](../docs/design/decisions/0028-external-vs-bundled-meilisearch.md). Parts 3–6
would each get an ADR of their own.

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
  of whichever lands second.
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

# 32. Embedded mode: Tier 1 as one binary and one data directory

Date: 2026-10-15

## Status

Proposed. Nothing is built; this records the option and its costs so the decision can
be argued on paper first. Two smaller steps toward a denser package are tracked as
issues and don't depend on it (see Consequences).

## Context

Tier 1 ([ADR 0015](0015-tiered-architecture.md)) is one machine and one user. What
it ships today is a stack of seven containers:

- the app (webapi, webui, docs, CLI);
- CouchDB, Garage and Meilisearch;
- the Garage and Meilisearch admin UIs;
- Fossil ([ADR 0031](0031-fossil-as-bundled-infrastructure.md)).

They're generated from the blueprint, so the cost isn't drift. The cost is weight:

- Docker becomes a hard prerequisite.
- About eight ports are published.
- There are seven images to pull, mirror and scan.
- There are secrets to generate (CouchDB admin, Garage RPC).
- Each backing service has its own upgrade cadence.

For a single user who wants their sessions recorded, that's a lot of machinery. Every
service but CouchDB is already optional.

Each store has a close equivalent that runs inside the Bun process itself, with
nothing to install:

| Server store (today) | Embedded equivalent |
|---|---|
| CouchDB — event, summary and chunk docs; views; `_find`; `_changes` | `bun:sqlite`: documents as JSON rows, views as indexed queries (JSON1 / generated columns), change tracking as a sequence column |
| Garage (S3) — transcript blobs | files under the data directory, behind the existing `BlobStore` interface (`packages/webapi/src/storage/blob-store.ts`) |
| Meilisearch — derived search index | SQLite FTS5 in the same database file |
| Fossil — repositories | already one SQLite file per repository; the static binary can be embedded and spawned |

So "embedded mode" would be:
- one `claude-transcripts` binary, with the webui and docs embedded (`bun build --compile`);
- one data directory holding a SQLite database, a blob folder and Fossil repositories;
- zero containers.

The hook is the same binary and opens the same database. SQLite in WAL mode allows a
second process on the same machine to write, which keeps the hook independent of the
webapi being up, as [ADR 0016](0016-webapi-is-the-io-gateway.md) requires.

## Options

1. **Status quo.** Tier 1 is the compose stack (or the k8s base).
2. **A supervisor appliance.** Put every service in one image under s6-overlay or
   similar. One container to run, but the same services inside, plus a supervisor.
   Upgrades get worse, because every upstream's cadence becomes ours. Density on
   paper, not in practice.
3. **Embedded mode as a second backend family.** Storage drivers selected by
   config: `server` (today's stores, unchanged) and `embedded` (SQLite + files).
   Tier 1 defaults to `embedded`; Tier 2/3 and anyone who wants replication use
   `server`.
4. **Embedded only.** Replace the server stores outright. This gives up CouchDB
   replication and the external-backend support of
   [ADR 0028](0028-external-vs-bundled-meilisearch.md); it's listed for completeness.

## Proposal

Option 3, introduced behind interfaces in this order:
1. Blobs, since `BlobStore` already exists and a filesystem driver is small.
2. Search (FTS5, behind the same interface the Meilisearch client presents).
3. The document store last, because it's the large one.

Embedded mode becomes the Tier 1 default only once all three are complete. A
half-embedded stack would be the worst of both worlds.

Constraints any implementation must keep:
- **The hook still never blocks a session.** Writes go to SQLite with a short busy
  timeout, and a locked database is a logged miss, never a stall.
- **Append-only documents** (CLAUDE.md invariants) carry over unchanged: rows are
  inserted, never updated.
- **The blueprint stays the source of truth.** "Which driver" is a blueprint fact,
  and the compose, k8s and installer projections follow it. In embedded mode, the
  installer writes no compose files at all.
- **The OpenAPI contract doesn't change.** Clients can't tell the drivers apart.
  The read-only `/api/couch` proxy is the exception: it is CouchDB's API, so it
  answers 404 in embedded mode (or is replaced by an equivalent read surface).
- **One-way migration to begin with.** An `export`/`import` between drivers, so a
  Tier 1 user can move to `server` when they outgrow embedded mode.

## Consequences

**Cost.** CouchDB-specific code is spread through the webapi, CLI and shared
packages: 17 non-test files use views, `_find` or `_changes`. On top of that:
- the design-doc migrations ([ADR 0021](0021-self-built-couchdb-migrations.md));
- the `_changes` follower that feeds the session index;
- the CouchDB read proxy.

Each needs a driver-neutral seam before a second driver can exist. That seam is most
of the work, and it's worth having even if embedded mode is never built.

**What's lost in embedded mode:**
- CouchDB replication;
- Fauxton as a no-code data browser (the webui and Fossil remain);
- the "bring your own S3 or Meilisearch" story ([ADR 0003](0003-vendor-neutral-s3-drop-minio-and-rclone.md), 0028).

All three remain in `server` mode. The hook's existing mirroring (writing each
session to a second instance's ingest surface) partly covers multi-machine use.

**What's gained:**
- install becomes "download one file";
- no Docker, no secrets, no port block (one port);
- one thing to back up (the data directory);
- the CLI and app versions can never skew, because they're the same file.

**Not decided here:** whether Tier 1's *default* flips to embedded mode. That's a
product decision for after the first two drivers exist and can be measured.

**Related issues** (independent of this ADR):
- [#223](https://github.com/vredchenko/claude-transcripts/issues/223): admin UIs behind a compose profile;
- [#224](https://github.com/vredchenko/claude-transcripts/issues/224): `claude-transcripts serve`, with the webapi, webui and docs embedded in the CLI binary, and the app image slimmed to that binary.

The latter is also the first step of this proposal.

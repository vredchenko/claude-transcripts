# 21. Self-built CouchDB migrations (up/down + views + export/import)

Date: 2026-06-18

## Status

Accepted. Amended 2026-08-07 — see [Amendment](#amendment-import-checks-rather-than-migrates-forward).

## Context

The document schema and the map-reduce design views will evolve (new doc types,
new fields on existing docs, added/changed/removed views). CouchDB has **no modern
migrations framework** of the kind relational ecosystems take for granted — there
is no standard, versioned, reversible up/down tooling. We need one, and it must
also understand our design views and our export/import bundle format, not just documents.

## Decision

Build our **own migration tooling** (lives in `tools/`, run via the CLI —
[tools.md](../../operate/tools.md), [cli.md](../../reference/cli.md)). It:

- **Versions the schema** via a stored marker doc (e.g. a `schema_version` doc in
  the database).
- **Migrates existing data up *and* down** — each migration declares both
  directions; running up applies pending migrations, down rolls back.
- **Migrates the map-reduce / aggregate design views** — creating, updating, and
  removing design docs as part of the same versioned step (so views never drift
  from the doc shapes they map over).
- **Participates in export/import** — the same machinery dumps/imports data
  to/from the application and brings imported data to the current schema version
  (so a bundle exported at v3 can be imported and migrated to v5).
- Respects append-only/immutability ([ADR 0016](0016-webapi-is-the-io-gateway.md)):
  prefer writing new docs / new design-doc revisions over destructive in-place
  edits; where a transform must rewrite, it does so explicitly and reversibly.
- Is **idempotent** and **`--dry-run`-able**, like the other `tools/` utilities.

## Consequences

- A migration registry (ordered, named migrations with `up`/`down`) plus the
  `schema_version` marker becomes part of the data model.
- Schema changes (#4, #7, the agent-first redesign #15) become migrations rather
  than ad-hoc scripts; `backfill`, export, and import all key off the same version.
- We own the maintenance burden of the tooling — accepted, because no off-the-shelf
  CouchDB option fits a vendor-neutral Bun/TS project.
- Design-view sync (the then-existing `hooks/couchdb/` ↔ `ensure.ts` mirror) folds
  into the migration step over time, so there is one authoritative path for view
  changes. *(Since done — the mirror is gone and the registry owns the designs.)*

## Amendment: import checks rather than migrates forward

*2026-08-07, when export/import was built ([bundles.md](../bundles.md)).*

The decision above says import "brings imported data to the current schema version (so a
bundle exported at v3 can be imported and migrated to v5)". Implementing it showed that
sentence to be both unnecessary and, read literally, unsafe.

**Unnecessary**, because every migration written so far only creates or updates
`_design/*` docs. Views are derived state: CouchDB recomputes them over whatever
documents exist, including ones restored a moment ago. A v3 bundle therefore restores
into a v5 instance correctly with no forward step at all.

**Unsafe**, because the marker is per **database**, not per document. Running `migrate
up` after an import cannot do what the sentence implies: the target is already at v5, so
nothing is pending, so nothing runs — while the restored documents sit there in the v3
shape. Had a document-transforming migration existed, "import, then migrate up" would
have reported success and left the database holding two shapes.

So the amended position: **import verifies rather than migrates.** It refuses a bundle
newer than the target (forward-only, unchanged), and refuses an older bundle whose
version gap contains a migration declaring `transformsDocs: true`. Migrating an imported
bundle forward remains the right eventual answer, but it needs migrations to expose a
document pass that can be **scoped to the restored ids** — not the whole-database `up`
this ADR assumed. That work waits for the first document migration, since there is
nothing to test a replay against until then.

# 21. Self-built CouchDB migrations (up/down + views + export/import)

Date: 2026-06-18

## Status

Accepted

## Context

The document schema and the map-reduce design views will evolve (new doc types,
new fields on existing docs, added/changed/removed views). CouchDB has **no modern
migrations framework** of the kind relational ecosystems take for granted — there
is no standard, versioned, reversible up/down tooling. We need one, and it must
also understand our design views and our export/import bundle format, not just documents.

## Decision

Build our **own migration tooling** (lives in `tools/`, run via the CLI —
[tools.md](../tools.md), [cli.md](../cli.md)). It:

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
- Design-view sync (the existing `hooks/couchdb/` ↔ `ensure.ts` mirror) folds into
  the migration step over time, so there is one authoritative path for view
  changes.

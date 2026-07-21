# Data & schema migrations

> **Status: engine built (up/down/status + boot auto-apply); export/import bundle
> round-trip still to come.** Decision recorded in
> [ADR 0021](decisions/0021-self-built-couchdb-migrations.md).

CouchDB has no modern migrations framework, so we build our **own** — a versioned,
reversible tool that migrates documents **and** design views and plugs into the
`export`/`import` bundle round-trip. It is a user-useful operation, exposed and
driven through the [CLI](cli.md).

## What it does

- **Schema versioning** — a single marker (a `schema_version` doc in the database)
  records the current version. Migrations are ordered and named.
- **Up / down** — each migration declares both directions. `up` applies pending
  migrations; `down` rolls the last N back.
- **Documents** — transform existing docs to the new shape. Respecting
  append-only/immutability ([ADR 0016](decisions/0016-webapi-is-the-io-gateway.md)),
  prefer adding new docs / fields and coalescing missing fields in views (the #7
  backward-compat pattern) over destructive rewrites; where a rewrite is
  unavoidable it's explicit and reversible.
- **Design views** — create / update / remove map-reduce + aggregate design docs as
  part of the same versioned step, so views never drift from the doc shapes they
  map over. Over time this subsumes the current `hooks/couchdb/` ↔ `ensure.ts`
  mirror sync into one authoritative path.
- **Export / import** — the same machinery dumps and imports data to/from the
  app, and **brings imported data up to the current schema version** (a bundle
  exported at v3 imports and migrates to v5).

## Properties

- **Idempotent** and **`--dry-run`-able**, like all CLI utilities.
- **Vendor-neutral** — CouchDB over HTTP, S3 via env; no host assumptions.
- `backfill` (#6) and export/import key off the same version, so adopted or
  restored history lands at the right schema.

## Shape (placeholder)

```
claude-transcripts migrate up [--to <version>] [--dry-run]
claude-transcripts migrate down [--steps N] [--dry-run]
claude-transcripts migrate status            # current version + pending
claude-transcripts migrate export <bundle>    # dump data (+ version)
claude-transcripts migrate import <bundle>    # import + migrate to current
```

## As built

The engine lives in `@claude-transcripts/shared` (`src/migrations/`), pure and
vendor-neutral over an abstract `MigrationContext` port; the **webapi** implements
the port against CouchDB and runs migrations (I/O gateway), and the **CLI** drives
it. There is one authoritative path for view changes — the webapi's boot
(`ensure.ts`) applies pending migrations too, so `INITIAL_DESIGNS` is the only home
for the design views.

- **Marker doc** — `schema_version` in the sessions DB:
  `{ type: "schema_version", version: <number>, applied: [{ id, name, at }] }`.
  Version `0` = pristine. The marker is written after **each** step, so an
  interrupted run stays consistent (every migration is idempotent → safe re-run).
- **Registry** — ordered `Migration` units (`{ id, name, up, down }`) in
  `migrations/registry.ts`. `id` is monotonic; never renumber or edit a released
  migration's `up` — add a new one. v1 (`initial-schema`) installs the base design
  views; v2 (`session-index-view`) adds the `_design/session_index` per-session
  aggregate that lets the reader surface `running`/`incomplete` sessions (started
  but no `summary` doc yet) — a worked example of adding a view through a migration.
- **Webapi routes** — `GET /api/migrate/status`, `POST /api/migrate/up`
  (`{ to?, dryRun? }`), `POST /api/migrate/down` (`{ steps?, dryRun? }`).
- **CLI** — `migrate status | up | down` (`--to`, `--steps`, `--dry-run`,
  `--webapi`).

The export/import bundle format (dump data + version, import-and-migrate-forward)
is the remaining piece, plus data-transforming migrations (the `allDocs` port hook
is already in place for them).

## Shape (as built)

```
claude-transcripts migrate status                     # current version + pending
claude-transcripts migrate up   [--to <version>] [--dry-run]
claude-transcripts migrate down [--steps <n>]    [--dry-run]
```

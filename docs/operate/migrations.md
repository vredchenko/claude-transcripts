# Data & schema migrations

> **Status: engine built (up/down/status + boot auto-apply); `export` and `import`
> built.** The bundle format is specified and implemented in
> [bundles.md](../design/bundles.md); a bundle records the schema version it was taken
> at, which is what lets `import` decide whether it can be restored. Decision recorded
> in [ADR 0021](../design/decisions/0021-self-built-couchdb-migrations.md).
>
> **Every migration to date is view-only** — each upserts `_design/*` docs and nothing
> else. That is not incidental: it is what makes restoring an older bundle into a newer
> instance safe, because views are derived and CouchDB rebuilds them over whatever docs
> exist. Document-transforming migrations are supported by the engine but none has been
> written, and the first one will need import taught to replay it — see
> [Documents](#documents) below.

CouchDB has no modern migrations framework, so we build our **own** — a versioned,
reversible tool that migrates documents **and** design views and plugs into the
`export`/`import` bundle round-trip. It is a user-useful operation, exposed and
driven through the [CLI](../reference/cli.md).

## What it does

- **Schema versioning** — a single marker (a `schema_version` doc in the database)
  records the current version. Migrations are ordered and named.
- **Up / down** — each migration declares both directions. `up` applies pending
  migrations; `down` rolls the last N back.
- **Documents** — transform existing docs to the new shape. Respecting
  append-only/immutability ([ADR 0016](../design/decisions/0016-webapi-is-the-io-gateway.md)),
  prefer adding new docs / fields and coalescing missing fields in views (the #7
  backward-compat pattern) over destructive rewrites; where a rewrite is
  unavoidable it's explicit and reversible.

  A document migration must set **`transformsDocs: true`**. Migrations are recorded per
  database, not per document, so a transform that has already run leaves a marker saying
  so — and `import` writing older-shaped docs into that database produces a mix that
  `migrate up` will never revisit, because it has nothing pending. The flag makes
  `import` refuse those bundles by name instead of restoring them into the wrong shape
  ([bundles.md](../design/bundles.md#why-an-older-bundle-is-not-automatically-safe)).
  Lifting the refusal means giving migrations a scoped document pass that import can
  replay over just the ids it restored.
- **Design views** — create / update / remove map-reduce + aggregate design docs as
  part of the same versioned step, so views never drift from the doc shapes they
  map over. This has since happened: the design docs are owned by the migration
  registry alone, and the former `hooks/couchdb/` ↔ `ensure.ts` mirror is gone.
- **Export / import** — a bundle records the schema version it was dumped at, and
  `import` uses it to decide whether the restore is sound: forward-only (a newer bundle
  is refused), and an older bundle is restored as-is while the migrations in between are
  view-only. A bundle exported at v3 restores into a v5 instance with no forward step,
  because v4 and v5 only rebuilt views.

## Properties

- **Idempotent** and **`--dry-run`-able**, like all CLI utilities.
- **Vendor-neutral** — CouchDB over HTTP, S3 via env; no host assumptions.
- `backfill` (#6) and export/import key off the same version, so adopted or
  restored history lands at the right schema.

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
- **Registry** — ordered `Migration` units (`{ id, name, up, down, transformsDocs? }`)
  in `migrations/registry.ts`. `id` is monotonic; never renumber or edit a released
  migration's `up` — add a new one. v1 (`initial-schema`) installs the base design
  views; v2 (`session-index-view`) adds the `_design/session_index` per-session
  aggregate that lets the reader surface `running`/`incomplete` sessions (started
  but no `summary` doc yet) — a worked example of adding a view through a migration.
  All nine are view-only; a unit test asserts it, so the first migration to set
  `transformsDocs` fails that test and points at what import needs taught.
- **Webapi routes** — `GET /api/migrate/status`, `POST /api/migrate/up`
  (`{ to?, dryRun? }`), `POST /api/migrate/down` (`{ steps?, dryRun? }`).
- **CLI** — `migrate status | up | down` (`--to`, `--steps`, `--dry-run`,
  `--webapi`).

Remaining: data-transforming migrations themselves (the `allDocs` port hook is already
in place for them), and the scoped replay `import` will need before one can be restored
across — until then `transformsDocs` makes import refuse rather than guess.

## Shape (as built)

```
claude-transcripts migrate status                     # current version + pending
claude-transcripts migrate up   [--to <version>] [--dry-run]
claude-transcripts migrate down [--steps <n>]    [--dry-run]

claude-transcripts export <dir> [--since ISO] [--session ID]… [--no-blobs]
claude-transcripts import <dir> [--dry-run] [--no-blobs]
```

# Migrations, export and import

```
claude-transcripts migrate status                    # current version + pending
claude-transcripts migrate up   [--to <n>] [--dry-run]
claude-transcripts migrate down [--steps <n>] [--dry-run]

claude-transcripts export <dir> [--since ISO] [--session ID]... [--no-blobs]
claude-transcripts import <dir> [--dry-run] [--no-blobs]
```

The webapi applies pending migrations on every boot, so you rarely need `migrate up`
by hand. The routes behind these commands are `GET /api/migrate/status`,
`POST /api/migrate/up` (`{ to?, dryRun? }`) and `POST /api/migrate/down`
(`{ steps?, dryRun? }`).

## Migrations

CouchDB has no migrations framework, so the project has its own
([ADR 0021](../design/decisions/0021-self-built-couchdb-migrations.md)): an engine in
`@claude-transcripts/shared` (`src/migrations/`), run by the webapi, driven by the CLI.

- **Registry** — ordered `{ id, name, up, down, transformsDocs? }` units in
  `migrations/registry.ts`. Ids are monotonic. Never renumber or edit a released
  migration; add a new one.
- **Marker** — a `schema_version` doc in the sessions database:
  `{ type: "schema_version", version, applied: [{ id, name, at }] }`. Version 0 is a
  pristine database. The marker is written after each step, and every migration is
  idempotent, so an interrupted run is safe to repeat.
- **Design docs live only here.** Every `_design/*` doc comes from the registry; to
  change a view, add a migration ([couchdb.md](../reference/couchdb.md#changing-a-view)).

All ten migrations so far are **view-only**: they upsert design docs and nothing else.
A document-transforming migration must set `transformsDocs: true`, because it changes what
`import` can safely restore (below). Migrations should prefer adding new docs or
fields, with views coalescing missing fields, over rewriting existing docs.

## Export and import

A bundle is a directory: `manifest.json`, `docs.ndjson` (one CouchDB doc per line,
`_rev` stripped) and `blobs/<sessionId>/` with the S3 objects byte for byte. It holds
the `summary`, `event` and `chunk` docs, the transcripts, and the schema version it was
taken at. Design docs, the schema marker, search indexes, secrets and app logs are left
out; the target rebuilds or keeps its own. Format and rationale:
[bundles.md](../design/bundles.md).

Both commands go through the webapi: export reads the `/api/couch` and `/api/s3`
proxies, import writes through `/api/ingest/*` and then reindexes search.

- **Re-importing is safe.** Every doc keeps its source `_id`, so a second import
  conflicts harmlessly instead of duplicating. An interrupted import is fixed by running
  it again.
- **Checksums are verified** before anything is written.
- **Schema versions decide what restores.** A bundle from a newer schema is refused. An
  older bundle is restored as is while every migration in between is view-only, since
  CouchDB rebuilds views over whatever docs exist. If any migration in the gap has
  `transformsDocs`, import refuses and names it: restoring old-shaped docs into a
  database that already counts the transform as applied would leave two shapes with
  nothing pending to fix them.
- **`--no-blobs`** skips transcripts: roughly a tenth of the size, and search and the
  transcript reader still work from the chunk docs.
- **A bundle is everything typed into or produced by Claude Code on that machine**,
  secrets included; nothing is masked. Export writes 0600 files in a 0700 directory.
  Treat it accordingly.

To copy history to another instance, export here and import with `--webapi` pointing
there ([mirrors.md](mirrors.md#failure-behaviour) shows this for filling a gap).

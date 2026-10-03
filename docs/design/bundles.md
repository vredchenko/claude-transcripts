# Export and import bundles

How `export` and `import` work and why. Usage is in
[migrations.md](../operate/migrations.md#export-and-import).

The driving case: dump an instance, tear it down, install fresh, restore. The same
mechanism moves history between machines and gives an off-instance backup that doesn't
depend on Docker volumes. It has been round-tripped against a real instance (about
7,000 docs, 43 transcripts, 117 MB): a deleted session came back identical, and
re-importing wrote no duplicates.

## Contents

**Included:** every `summary`, `event` and `chunk` doc (source `_id` kept, `_rev`
stripped), the S3 objects for those sessions byte for byte, and a manifest.

**Excluded**, because the target rebuilds or owns them: design docs (owned by
migrations), the `schema_version` marker (the manifest carries the version),
`_local/search_checkpoint` (a position in one CouchDB's change feed), search indexes
(rebuilt by `reindex`), the instance env and secrets, app logs.

The rule: a bundle carries what can't be recomputed.

## Format

A directory, not an archive, so it streams, can be inspected with ordinary tools and
needs no tar code in the CLI (`tar czf` it yourself if you want one file; JSONL
compresses well):

```
<bundle>/
  manifest.json
  docs.ndjson                       one doc per line
  blobs/<sessionId>/transcript.jsonl
  blobs/<sessionId>/summary.json    when present
```

```jsonc
{
  "format": 1,                       // bundle layout version, independent of the app
  "schemaVersion": 7,                // source's migration version
  "createdAt": "2026-08-02T10:00:00.000Z",
  "source": { "app": "0.0.1", "hostname": "…", "instance": "…" },
  "counts": { "sessions": 43, "docs": 7090, "blobs": 43 },
  "checksums": { "docs.ndjson": "sha256:…", "blobs/<id>/transcript.jsonl": "sha256:…" },
  "selection": { "since": null, "sessions": null, "blobs": true }
}
```

Transcripts are about 90% of a bundle's size, so export streams docs and blobs straight
to disk and computes checksums while writing; blobs are copied, never re-encoded. The
manifest is written last, so an interrupted export is visibly incomplete. Export reads
only live data, which makes a dump/restore also a full compaction.

## Import

1. Reach the webapi and read its schema version (refuse if unreachable: unknown is not
   the same as version 0).
2. Verify format and checksums before writing anything.
3. Compare schema versions (below).
4. Write through `/api/ingest/*`: summaries, events, chunks, then blobs.
5. Reindex search.

Re-import is idempotent: summaries and chunks have deterministic ids, and the bundle
keeps each event's source `_id`, so repeats conflict harmlessly and are counted as
already present. An interrupted import is resumed by running it again. Blobs are
re-uploaded even when identical, which makes a redundant restore slower than it needs
to be.

A newer CLI reads older formats; a `format` from the future is refused. The app version
doesn't decide compatibility; `format` and `schemaVersion` do.

### Importing an older bundle

- **Same schema** — import.
- **Bundle newer than the target** — refuse. The message tells an instance that is
  merely behind its own build (`migrate up`) from a build that doesn't know that schema
  (upgrade the app).
- **Bundle older** — import as is, provided every migration in between is view-only.
  CouchDB rebuilds views over the restored docs, so there is nothing to migrate.

"Import, then `migrate up`" does not work for a document-reshaping migration, and fails
silently: migrations are recorded per database, so a target at v9 already counts the v8
transform as applied, and docs restored in the v7 shape are never transformed. Hence
such a migration must declare `transformsDocs: true`, and import refuses any bundle
whose gap contains one, naming it. The real fix, replaying the transform over just the
restored ids, waits until a document migration exists to test it against.

## Privacy

A bundle is everything typed into or produced by Claude Code on that machine,
including pasted secrets; nothing is masked. Export writes 0600 files in a 0700
directory.

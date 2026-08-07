# Export / import bundles — design

**Status: built.** Both halves are implemented and verified against a real instance
(7,135 docs / 43 blobs / 117 MB). A session was destroyed — CouchDB docs and S3 object
— and restored from a bundle with every detail field, token count and transcript entry
identical; re-importing the full bundle wrote zero duplicate docs.

One behaviour worth knowing: import re-uploads every blob, even one already present
with identical bytes, because it doesn't compare before writing. Correct, but it makes
a redundant restore slower than it needs to be (16s for 102 MB here) — skipping
unchanged objects is an easy improvement when it matters.

The migration engine has carried a promise since 0.0.1 — "dump data + version, import
and migrate forward" ([migrations.md](../operate/migrations.md)) — that was never
implemented. This is that piece, with one correction the implementation forced: the
*migrate forward* half turned out to be unnecessary and, taken literally, wrong. Every
migration so far only rebuilds views, which CouchDB recomputes over restored docs on its
own. What an old bundle actually needs is not a forward migration but a **check** that
nothing in the version gap reshaped documents — see
[Why an older bundle is not automatically safe](#why-an-older-bundle-is-not-automatically-safe).

## The driving use case

> Dump an existing instance, tear it down, replace it with a clean install, restore.

That is the immediate need, and it doubles as the acceptance test. Everything below is
shaped by it: without a working round-trip, adopting the new install path
([installation.md](installation.md)) means abandoning whatever history a machine has
accumulated — the worst possible trade for the person most invested in the tool.

Two more uses fall out of the same mechanism: moving history between machines, and
keeping an off-instance backup that doesn't depend on Docker volumes surviving.

## Sizing reality

Measured on a real instance, and it changes the design:

| | Size |
|---|---|
| CouchDB `sessions` (active data) | **9.7 MB** across 7,090 docs |
| S3 transcripts | **106.7 MB** across 43 objects |

Blobs are roughly **11× everything else**. So a bundle with blobs is, to a first
approximation, a pile of transcripts — which means the format must **stream** rather
than build anything in memory, and blobs must be copied byte-for-byte rather than
re-encoded (base64 in JSON would inflate them by a third for no benefit).

Worth noting in passing: that CouchDB is 9.7 MB of live data in a 92.7 MB file. Export
reads live data only, so a dump/restore cycle is also the most thorough compaction
available.

## What a bundle contains

**Included**

- Every `summary`, `event` and `chunk` doc from the sessions database, with the source
  `_id` preserved and `_rev` stripped.
- Every S3 object for those sessions — `transcript.jsonl`, and `summary.json` where one
  exists — byte-for-byte.
- A manifest: format version, **schema (migration) version**, creation time, source
  identity, counts and checksums.

**Deliberately excluded**

- **Design documents** (`_design/*`). They're owned by migrations; importing them
  would let a stale copy overwrite the target's views.
- **The `schema_version` marker.** The manifest carries the version; the target's own
  marker must keep describing the target.
- **`search_checkpoint`.** Instance-specific — it names a position in *that* CouchDB's
  change feed and is meaningless anywhere else.
- **Meilisearch indexes.** Derived state, rebuilt by `reindex`
  ([ADR 0009](decisions/0009-meilisearch-search.md)). Shipping them would bloat the
  bundle with something reconstructible.
- **The instance env, secrets and ports.** A bundle is data, not a machine
  configuration. Restoring into a fresh install must not resurrect the old install's
  credentials.
- **App logs** (`claude-transcripts-app-logs`). Operational, not history. `--logs`
  can opt in.

The rule behind all of it: **a bundle carries what cannot be recomputed.** Anything
derivable from the data is left for the target to rebuild.

## Format

A **directory**, not a single archive:

```
<bundle>/
  manifest.json
  docs.ndjson                       one CouchDB doc per line, _rev stripped
  blobs/<sessionId>/transcript.jsonl
  blobs/<sessionId>/summary.json    when present
```

A directory streams naturally, can be inspected with ordinary tools, lets a failed
import resume, and needs no tar implementation inside the CLI. `tar czf bundle.tgz
<bundle>/` is one command away when a single file is wanted, and stays the user's
choice — compressing 100 MB of JSONL is worth it (it compresses very well), but doing
it implicitly would make every export slow and every bundle opaque.

`manifest.json`:

```jsonc
{
  "format": 1,                       // bundle format, independent of app version
  "schemaVersion": 7,                // source's migration version — drives import
  "createdAt": "2026-08-02T10:00:00.000Z",
  "source": { "app": "0.0.1", "hostname": "…", "instance": "…" },
  "counts": { "sessions": 43, "docs": 7090, "blobs": 43 },
  "checksums": { "docs.ndjson": "sha256:…", "blobs/<id>/transcript.jsonl": "sha256:…" },
  "selection": { "since": null, "sessions": null }   // what was asked for, for provenance
}
```

`format` is versioned separately from the app because a bundle outlives the version
that wrote it — that's the entire point.

## Export

```
claude-transcripts export <dir> [--since ISO] [--session ID]… [--no-blobs] [--logs]
```

Reads through the webapi, like everything else: `/api/couch/*` for docs and
`/api/s3/*` for blobs ([ADR 0016](decisions/0016-webapi-is-the-io-gateway.md)). Docs
stream to `docs.ndjson` as they arrive; blobs stream object → file without buffering.
Checksums are computed during the write, not by re-reading.

`--no-blobs` produces a metadata-and-content bundle roughly a tenth the size: sessions,
events and chunks — so search and the chunk-first transcript read both still work after
restore — but no byte-exact transcripts.

## Import

```
claude-transcripts import <dir> [--dry-run] [--no-blobs]
```

1. **Verify** the manifest, format version and checksums before writing anything. A
   truncated bundle must fail loudly, not half-restore.
2. **Compare schema versions.**
   - equal → import as-is;
   - bundle **older** → import as-is *while the migrations in between are view-only*,
     which is every migration written so far. Views are derived: CouchDB recomputes them
     over the restored docs, so there is nothing to migrate forward. If any migration in
     the gap reshapes **documents** (`transformsDocs`), refuse — see below;
   - bundle **newer** than the target → refuse. Migrations only run forward, and
     guessing at a future schema is how data gets corrupted. The message distinguishes
     an instance that is merely behind its own build (`migrate up` fixes it) from a
     build that has never heard of that schema (upgrade the app), because `migrate up`
     cannot help with the second and saying so saves a wasted attempt.

### Why an older bundle is not automatically safe

The obvious reading — "import, then run `migrate up`" — does not work, and it is worth
being precise about why, because it fails *silently*.

Migrations are recorded per **database**, not per document. A target at v9 has a marker
saying v9. Import writes v7-shaped docs into it. `migrate up` reads the marker, finds
nothing pending, and does nothing. The v8 document transform — which ran once, over the
documents that existed at the time — never sees the restored ones. The database now
holds two document shapes, and every version check along the way passed, because "bundle
older than target" is the branch we treat as safe.

Nothing exercises this today: all seven migrations upsert `_design/*` docs and nothing
else, so every gap is view-only and every restore is genuinely safe. The risk is
entirely in the future, which is why the guard is a **declaration on the migration**
rather than an inspection of the data: a migration that reshapes documents sets
`transformsDocs: true`, and import refuses any bundle whose gap contains one.

The real fix is for import to **replay** a document transform over just the ids it
restored — which needs migrations to separate their design-doc work from their
document work (`up` vs a scoped `upDocs`). That is deliberately deferred until the first
such migration exists, because a replay mechanism with nothing to replay cannot be
tested honestly. Until then the guard converts a silent, permanent inconsistency into a
refusal that names the migrations responsible.
3. **Write** through `/api/ingest/*` — summaries, events, chunks, then blobs. Never
   direct to the stores.
4. **Reindex** so search reflects the restored corpus (the `_changes` follower catches
   the writes as they land, but a rebuild after a bulk restore is the honest way to be
   sure).

**Idempotency.** Re-importing the same bundle must not duplicate anything, and the
mechanism already exists: `summary:<id>` and `chunk:<id>:<byteStart>` have deterministic
ids, so a second write conflicts and is counted as already-present. The one gap is
`event` docs, whose ids are CouchDB-assigned — so **the bundle preserves each event's
source `_id`**, which makes re-import conflict the same benign way. The ingest schema
already passes `_id` through, so this needs no API change.

## Edge cases

- *Bundle newer than the target's schema.* Refuse with the version gap named, and with
  the fix that actually applies — `migrate up` when the instance is behind its own
  build, upgrading the app when the build itself is too old (see above).
- *Bundle older, with a document-reshaping migration in the gap.* Refuse, naming the
  migrations. Import into an instance at the bundle's schema version instead. Cannot
  happen today — every migration is view-only.
- *Bundle written by a newer CLI than the one importing.* Refused on `format`, since a
  layout from the future can't be read. The reverse — a newer CLI reading an older
  bundle — is explicitly supported: that is what versioning `format` separately from the
  app is for.
- *The webapi is unreachable.* Refuse before reading the bundle. An instance that can't
  report its schema version is not the same as one at v0, and treating them alike would
  pick an import path with no evidence behind it.
- *Target already holds some of this history.* Fine — every write is an upsert or a
  benign conflict. Import reports how many docs were new.
- *Truncated or corrupted bundle.* Checksums catch it up front; nothing is written.
- *Interrupted import.* Re-run it. Every write is idempotent, so resumption is just
  "do it again".
- *Interrupted export.* The bundle has no manifest until the end, so a partial dump is
  self-evidently unusable rather than quietly short.
- *Blobs missing for a session* (adopted with `--no-content`, or S3 was down). Record
  it in the manifest and carry on: a session with metadata and chunks is worth keeping.
- *No S3 on the target.* `--no-blobs` on import, or blobs are skipped with a warning —
  CouchDB content still restores.
- *Bundle from a different app version.* Allowed. `format` and `schemaVersion` decide
  compatibility, not the app version, precisely so old dumps stay restorable.
- *Session id collision from another machine.* Ids are UUIDs; a genuine collision means
  the same session, so upsert is right.
- *Disk space.* Export needs roughly the live data size (~117 MB here, uncompressed).
  Check before starting rather than failing halfway.

## Privacy

A bundle is a **complete, portable copy of everything ever typed into or produced by
Claude Code on that machine** — including anything secret that was pasted into a
prompt. `secretsMasking` is still an unimplemented feature flag, so nothing is
redacted today.

Export therefore writes 0600 files into a 0700 directory, and the docs must say plainly
what a bundle is before anyone emails one to a colleague or drops it in cloud storage.

## Acceptance

The round-trip that motivated it, end to end:

1. `export` an instance with history;
2. `uninstall --purge`;
3. `install` fresh;
4. `import` the bundle;
5. session count, transcripts, and search results match the original, and a
   re-`import` changes nothing.

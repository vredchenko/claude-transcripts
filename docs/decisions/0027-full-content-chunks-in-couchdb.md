# 27. Full-content chunks in CouchDB (per-turn content, not just byte ranges)

Date: 2026-07-22

## Status

Proposed

## Context

A session is stored two ways. The **byte-faithful transcript** lives in S3 as a
single `transcript.jsonl` object ([ADR 0014](0014-transcripts-live-in-s3-only.md)),
and CouchDB holds append-only **metadata**: `event` markers, a `summary` doc at
SessionEnd, and — added since — `chunk` docs written mid-flight for crash
resilience ([mid-flight-chunking.md](../mid-flight-chunking.md)).

The **mid-flight chunking mechanism is already built**: the hook flushes `chunk`
docs as the session grows, ingest is idempotent with stable ids
(`chunk:<session>:<byteStart>`), and `backfill` reconstructs the same chunks for
adopted history. But a `chunk` doc today records only a **byte-range slice** —
`byte_start`, `byte_end`, `entry_count` — a pointer into the S3 transcript. It does
**not** contain the messages.

The consequence: CouchDB cannot see an individual turn. Anything that needs
per-turn structure — **speaker-split views** (user vs Claude), per-turn search
indexing, map-reduce **feature extraction**, prompt/instruction provenance — is
blocked, because the only place the turns exist in parsed form is the S3 blob, and
map-reduce can't run over S3. The `couchFullContentChunks` feature flag was added
in anticipation of this but nothing populates content yet.

This is the remaining half of the logging rework (roadmap #4).

## Decision

Promote `chunk` docs from byte-range pointers to **full-content chunks**: parse the
transcript entries and store their content in CouchDB, so map-reduce views operate
directly on turns.

- **A chunk carries its parsed entries.** In addition to the existing byte-range
  fields (kept, so a chunk still maps 1:1 to a transcript slice and stays
  reconstructable), a `chunk` doc gains the parsed entries it covers: for each,
  the **role/type** (`user` | `assistant` | tool result | system), a stable
  per-entry index, timestamps, and the content (text + tool-use structure). The
  exact per-entry projection is defined in
  [couchdb-documents.md](../couchdb-documents.md) and the shared validators, not
  here.
- **Append-only + immutable**, like every other doc
  ([ADR 0016](0016-webapi-is-the-io-gateway.md)): content chunks are written once
  by the writer (hook or `backfill`), keyed by byte offset, never edited in place.
- **Schema-versioned + migrated.** The new fields and the design views that read
  them ship through the self-built migrations
  ([ADR 0021](0021-self-built-couchdb-migrations.md)), never ad-hoc — `chunk` docs
  carry `schema_version`, and a migration can re-derive content chunks for existing
  sessions from their S3 transcript.
- **S3 stays the source of truth** ([ADR 0014](0014-transcripts-live-in-s3-only.md)).
  Content chunks are a **projection** of the transcript for query, not a second
  authority; they are byte-attributable back to the S3 object and rebuildable from
  it. The transcript is never reconstructed *from* chunks.
- **Byte-identical writer/shared code.** The parse + chunk-content builder is
  written once in `@claude-transcripts/shared` and copied byte-identically into the
  hook (which can't resolve the workspace), exactly as `sumTranscriptTokens` and
  `sliceIntoChunks` already are.
- **Guarded by `couchFullContentChunks`.** The flag gates population and the
  content-reading views, so the byte-range-only behaviour remains a fallback.

## Consequences

- **Unlocks** speaker-split views, per-turn search (Meilisearch indexing over
  turns), map-reduce feature/analytics views, and prompt/instruction provenance —
  all of which become straightforward map functions over `role`/content.
- CouchDB **storage grows**: the corpus is effectively stored twice (S3 blob +
  parsed content in Couch). Accepted for Tier-1/2 volumes; chunk granularity
  (`maxEntriesPerChunk`) bounds per-doc size, and content chunks can be pruned/
  re-derived from S3 since S3 remains authoritative.
- The content projection must track **Claude Code's transcript entry shape**; a
  drift check (cf. [ADR 0025](0025-claude-code-compatibility-matrix.md)) guards it,
  and the `schema_version` + migration path absorbs format changes.
- A **migration** backfills content chunks for already-recorded sessions from their
  S3 transcripts, so history is not left behind.
- Redaction/secrets-masking ([app-logging.md](../app-logging.md), #11) becomes more
  load-bearing: parsed content in Couch is more directly queryable than an opaque
  blob, so masking-on-write matters more here.

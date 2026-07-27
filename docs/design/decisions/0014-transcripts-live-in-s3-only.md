# 14. Transcripts live in S3 only — CouchDB attachment support removed

Date: 2026-06-08

## Status

Accepted (supersedes [ADR 0013](0013-s3-is-the-transcript-home-couch-attachment-opt-in.md)
and the remaining attachment-read parts of
[ADR 0011](0011-read-couch-attachments-over-http.md))

## Context

[ADR 0013](0013-s3-is-the-transcript-home-couch-attachment-opt-in.md) made S3 the
transcript's durable home and demoted the CouchDB transcript attachment to an
opt-in, gated on the `couchTranscriptAttachment` feature flag (default `false`),
"for deployments without an S3 backend." The webapi still read transcripts S3-first
with a fall back to a legacy CouchDB attachment.

In practice the flag was never enabled, S3 is part of the standard stack
([ADR 0008](0008-garage-s3-object-store.md)), and the dual code paths carried real
cost: an opt-in write branch in the hook and the on-disk backfill (`backfill`), a
raw-HTTP attachment reader in the webapi, and `hasTranscript` / `transcriptSize` logic that
had to consult `_attachments` *or* `transcript_bytes`. The "no S3" escape hatch
isn't worth a permanent second storage path — a deployment without an object store
can run any S3-compatible server (Garage, MinIO, R2, AWS) by setting env.

The 281 legacy `summary:<id>` docs that still carried a `transcript.jsonl`
attachment were verified recoverable from S3 (every attachment byte-identical to,
or a byte-exact prefix of, the Garage copy), then removed and the DB compacted
(367 MB → 17 MB) before this change.

## Decision

Remove CouchDB transcript-attachment support entirely:

- **Hook / `backfill`** no longer write a transcript attachment under any
  condition. The `couchTranscriptAttachment` feature flag and the `putAttachment`
  CouchDB helper are deleted.
- **S3 is the transcript's sole durable home.** The hook uploads
  `transcript.jsonl` (and `summary.json`) only to the S3 blob store.
- **The webapi reads transcripts from S3 only.** The raw-HTTP attachment reader
  (`readCouchAttachment`) is gone; there is no CouchDB fallback.
- `hasTranscript` / `transcriptSize` derive **solely** from the summary doc's
  `transcript_bytes`.

## Consequences

- CouchDB holds only event + summary docs — no transcript bytes, ever. The
  primary store stays compact; replication and view builds are cheaper.
- A deployment with **no** S3 backend no longer persists transcript content at all
  (only the summary doc's `transcript_bytes` is recorded). S3 is now a hard
  requirement for keeping transcripts — documented in `docs/hook-setup.md`.
- `hasTranscript` depends on `transcript_bytes` being set. The legacy
  attachment-only docs were backfilled with `transcript_bytes` (from their S3
  object size) as part of the attachment removal, so they still surface in the UI.
- The Bun-specific `nano.attachment.get` finding from
  [ADR 0011](0011-read-couch-attachments-over-http.md) no longer applies to this
  codebase (no attachment is read); the ADR is retained only as history.

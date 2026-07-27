# 8. Garage as the S3 object store

Date: 2026-06-06

## Status

Accepted

## Context

The project needs S3-style block/object storage **in addition to** the document
DB (see "Why object storage at all" below). [ADR 0003](0003-vendor-neutral-s3-drop-minio-and-rclone.md)
already settled that we address it through Bun's vendor-neutral S3 client over a
single backend; this record is about *which* backend is the reference, and why.

Background: an earlier deployment migrated its object store from MinIO to Garage.
MinIO is **no longer maintained as FOSS**, which forced a replacement; Garage was
chosen. The same reasoning carries here.

## Decision

Use **Garage** as the reference S3 backend.

- **FOSS, lightweight, self-hosted, geo-distributed.** It co-locates on the same
  homelab nodes and is designed for distribution across them — matching this
  project's posture (FOSS, low lock-in, sovereign).
- **Sovereignty over convenience.** S3 / Cloudflare R2 / AWS remain *mechanically*
  possible (the storage layer is vendor-neutral — ADR 0003) and may be offered as
  future options, but defaulting to them cuts against the FOSS philosophy and data
  sovereignty. This is a tool that runs **p2p or solo on local dev machines, right
  next to Claude Code**.
- **Don't export the jackpot.** Local-only storage does nothing about the Claude
  Code threat vector itself (Claude Code already sees everything locally), but it
  avoids shipping the *entire* session corpus — transcripts and whatever sensitive
  material they contain — to an external third party. (Secret scanning/masking is
  separately on the roadmap; see README "Future scope".)
- **Browsable without the custom webui.** Garage exposes an admin API + CLI, and
  the community `garage-webui` gives bucket/object browsing — same rationale as
  CouchDB's Fauxton ([ADR 0007](0007-couchdb-primary-store.md)): the data stays
  usable even if you never run this project's UI.

### Why object storage at all (not just CouchDB)

- **Durable backup / archival** of transcripts and summaries, independent of the
  DB. The blob store holds each session's `transcript.jsonl` + `summary.json`.
  (This ADR originally noted the transcript was *also* a CouchDB attachment; that
  attachment was later removed — S3 is now the transcript's sole home, see
  [ADR 0014](0014-transcripts-live-in-s3-only.md).)
- **Non-DB artifacts** that don't belong in a document store — and this is the
  larger future motivation: files/images/zips/docs that are *inputs* to a Claude
  Code session (a pasted screenshot in a prompt), outputs like Playwright e2e
  screenshots, and an open-ended set of future "binary blobs adjacent to a
  session" needs. CouchDB attachments don't scale to that; an object store does.

## Consequences

- Garage is the backend the docs, `deploy/` stack, and defaults target; any
  S3-compatible store still works by changing endpoint + credentials (ADR 0003).
- The bundled `deploy/` stack runs Garage **and** the community `garage-webui`,
  so buckets/objects are browsable without this project's own UI — honouring the
  rationale above.
- Buckets are provisioned out-of-band (the app/hook never create buckets) — the
  Garage bootstrap is documented in `deploy/README.md`.
- The object store is currently used only for transcript/summary blobs; the
  artifact use cases above (session input/output files) are future scope and will
  shape bucket layout + key conventions when built.

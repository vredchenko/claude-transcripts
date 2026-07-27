# 7. CouchDB as the primary store

Date: 2026-06-06

## Status

Accepted

## Context

The session log is **heterogeneous, schemaless data**: a stream of event docs
whose fields vary by event type (`SessionStart`, `PostToolUse`, `SubagentStop`,
…), plus an end-of-session `summary` doc, plus the raw transcript. We needed a
primary store that fits that shape and serves several downstream consumers (a web
UI, the API, ad-hoc inspection, and — by design — Claude Code itself).

## Decision

Use **CouchDB** as the primary store (database `claude-sessions`). What won it:

- **Schemaless document fit.** Event docs of differing shapes coexist with no
  migrations; new fields (see "Future scope" in the README — CLI version, config
  fingerprint, host/user identity) just get written.
- **HTTP-native + built-in admin UI.** Everything is plain HTTP, so the hook
  writes with nothing but `fetch` (no driver), and CouchDB's bundled admin UI,
  Fauxton (at `/_utils`; the successor to the old Futon), makes the data usable
  and browsable *even with no custom webui* — the webui is a convenience, not a
  dependency.
- **Map/reduce projections.** A single corpus of session logs is projected many
  ways via design-doc views — by date, by cwd, by tool usage, an activity
  timeline, token totals — and more "interesting session features" can be added
  as new views without touching the write path. (See `hooks/couchdb/` and
  `packages/webapi/src/storage/ensure.ts`.)
- **Replication for multi-machine / multi-user aggregation.** A designed-for
  future capability: CouchDB instances linked over a Tailscale network can
  horizontally replicate so a **team shares its Claude Code usage history**. Every
  doc already carries a `hostname` (and host/user fingerprinting is on the
  roadmap) to seed per-machine/per-user attribution once instances are linked.
- **Consumable by Claude Code itself.** The history is meant to be read back *by
  Claude Code* — for referencing prior work, retros, and custom context-building.
  With shared/replicated history, one Claude Code session can see what other
  sessions (or other teammates' sessions) have been doing, or surface what others
  are struggling with.
- **Portability + low lock-in.** CouchDB is FOSS, lightweight, built on Erlang/OTP,
  and avoids vendor lock-in — and is a long-standing personal preference of the
  owner.

Transcripts are stored both as a CouchDB **attachment** on the summary doc (so the
data is self-contained even with no object store) and as an S3 blob (durable
copy) — see [ADR 0008](0008-garage-s3-object-store.md).

> **Update:** the CouchDB attachment was later removed —
> [ADR 0014](0014-transcripts-live-in-s3-only.md) makes S3 the transcript's sole
> home. CouchDB now holds only event + summary docs.

## Consequences

- The hook stays trivially portable: HTTP `PUT`/`POST`, no client library.
- Aggregations are added as views, not as new tables or pipelines; the live write
  path is unaffected by new projections.
- **Multi-machine aggregation is an explicit design goal, not an afterthought** —
  replication topology, conflict handling, and auth across linked nodes are
  future work (and a future ADR) but the document model and `hostname` stamping
  are already laid for it.
- The webui and any future Claude-Code-facing reader are consumers of the same
  views, not privileged paths.
- Operationally CouchDB must be reachable over HTTP with basic auth; credentials
  live in the hook config and the webapi env.

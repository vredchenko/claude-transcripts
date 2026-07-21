# cli/ — operational CLI utilities

`cli/` is the home for **standalone command-line utilities** that work with
session data outside the live logging path: transcript parsing, history adoption
(`backfill`), reconciliation, export/import bundles, and schema migrations. The hook
writes sessions live; the app reads them; `cli/` is the by-hand operational
tier against the same CouchDB + S3 backend.

> Note: dev-only repo build automation (orval client gen, image mirroring, release)
> lives separately under `scripts/` ([dev-automation.md](dev-automation.md)) — these
> user-useful operational commands live in `cli/`.

See [`cli/README.md`](../cli/README.md) for the directory's own quick index.

## Why a separate tier

Keeping these out of both the hook and the app is deliberate:

- The **hook stays a thin writer** — no operational subcommands on the session
  hot path. (This also aligns with the agent-first direction in
  [#15](roadmap.md), where the host hook shrinks further.)
- The **app stays a reader** — no destructive/admin operations behind the HTTP
  API.
- Utilities here can be **homelab-agnostic and vendor-neutral** by construction:
  CouchDB over HTTP, S3 via `S3_*` env, no host paths or rclone/MinIO assumptions.

## Design rules

- **Standalone + optional.** Nothing here is a dependency of live logging; an
  absent or broken tool degrades a manual workflow, never a running session.
- **Idempotent + `--dry-run`.** Anything that writes takes `--dry-run` and is
  safe to re-run (skip work already done).
- **Schema parity with the hook.** Tools that write session docs reuse the hook's
  document shapes and the `sumTranscriptTokens` rule (its byte-identical-copy
  invariant — see [hook.md](hook.md) / [webapi.md](webapi.md)).
- **Bun + TypeScript**, reading the same `.env` (`COUCHDB_*`, `S3_*`) as the rest
  of the repo — see [configuration.md](configuration.md).

## Planned utilities

| Utility | Purpose | Status today | Tracking |
|---------|---------|--------------|----------|
| **transcript-parser** | Parse a `<id>.jsonl` transcript into typed entries (messages, tool uses, usage). Reused by `backfill` and as a **verification oracle** — diff CouchDB content against the fs transcript. Token math validated against `ccusage`. | partial — `hooks/scripts/transcript-tokens.ts` | #6 |
| **backfill** | "Adopt this machine's history": read on-disk `~/.claude/projects/**/<id>.jsonl` transcripts and reconstruct each session at **parity with the live hook** — the `summary:<id>` doc (`source: "backfill"` + `backfilled_at`) **and** per-event marker docs (so `events/*`, `tools/*`, `activity/timeline` views populate) and, planned, `chunk` docs — plus the S3 transcript blob. Preserves the transcript's real per-entry timestamps (never stamps backfill time into `timestamp`); attributes by `--host` / `--actor`; skips sessions already present. Flags: `--dir`, `--host`, `--actor`, `--webapi`, `--dry-run`. | exists — `packages/cli/src/commands/backfill.ts` (chunk docs + subagent sub-transcripts still TODO) | #6, #7 |
| **reconcile** | Finalize stale `running`/`incomplete` sessions (no `SessionEnd` fired) from their CouchDB chunks and/or the S3 transcript → write the missing `summary:<id>`. | planned | #4 |
| **export / import** | Dump (`export`) and restore (`import`) a session (or date range) as a portable bundle — summary + event docs + chunks + S3 blobs — for moving history between backends. | planned | — |
| **migrate** | Self-built CouchDB migrations: version the schema, migrate docs **up/down**, create/update/remove design views, and bring export/import bundles to the current version. CouchDB has no modern migrations tool, so we build our own. | planned | [migrations.md](migrations.md), [ADR 0021](decisions/0021-self-built-couchdb-migrations.md) |

### One `backfill` command (#6)

There is a **single** `backfill` command (an earlier design split it into a
summary-only pass and a full-parity *intake* pass, since merged). It does the
full-parity job in one pass: it writes the **summary doc + per-event marker docs**
(and, **planned**, `chunk` docs) so a backfilled session matches a live-recorded
one, rather than a thin summary-only record. Provenance is explicit — backfilled
summaries carry `source: "backfill"` + `backfilled_at`, distinct from the
`source: "live"` the hook writes — and the transcript's real timestamps are
preserved. Chunk-doc reconstruction and subagent sub-transcript capture are the
remaining gaps, tracked in issue #6 (planning).

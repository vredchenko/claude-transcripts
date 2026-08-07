# cli/ — operational CLI utilities

`cli/` is the home for **standalone command-line utilities** that work with
session data outside the live logging path: transcript parsing, history adoption
(`backfill`), reconciliation, export/import bundles, and schema migrations. The hook
writes sessions live; the app reads them; `cli/` is the by-hand operational
tier against the same CouchDB + S3 backend.

> Note: dev-only repo build automation (orval client gen, image mirroring, release)
> lives separately under `scripts/` ([dev-automation.md](../develop/dev-automation.md)) — these
> user-useful operational commands live in `cli/`.

See [`packages/cli/README.md`](../../packages/cli/README.md) for the directory's own quick index.

## Why a separate tier

Keeping these out of both the hook and the app is deliberate:

- The **hook stays a thin writer** — no operational subcommands on the session
  hot path. (This also aligns with the agent-first direction in
  [#15](../design/roadmap.md), where the host hook shrinks further.)
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
  invariant — see [hook.md](../reference/hook.md) / [webapi.md](../reference/webapi.md)).
- **Bun + TypeScript**, reading the same `.env` (`COUCHDB_*`, `S3_*`) as the rest
  of the repo — see [configuration.md](../start/configuration.md).

## Planned utilities

| Utility | Purpose | Status today | Tracking |
|---------|---------|--------------|----------|
| **transcript-parser** | Parse a `<id>.jsonl` transcript into typed entries (messages, tool uses, usage). Reused by `backfill` and as a **verification oracle** — diff CouchDB content against the fs transcript. Token math validated against `ccusage`. | partial — `hooks/scripts/transcript-tokens.ts` | #6 |
| **backfill** | "Adopt this machine's history": read on-disk `~/.claude/projects/**/<id>.jsonl` transcripts and reconstruct each session at **parity with the live hook** — the `summary:<id>` doc (`source: "backfill"` + `backfilled_at`) **and** per-event marker docs (so `events/*`, `tools/*`, `activity/timeline` views populate) and full-content `chunk` docs — plus the S3 transcript blob. Preserves the transcript's real per-entry timestamps (never stamps backfill time into `timestamp`); attributes by `--host` / `--actor`; skips sessions already present unless `--force` re-processes them. Flags: `--dir`, `--host`, `--actor`, `--chunk-size`, `--no-content`, `--force`, `--session`, `--webapi`, `--dry-run`. | exists — `packages/cli/src/commands/backfill.ts` (subagent sub-transcripts still TODO) | #6, #7 |
| **reconcile** | Finalize stale `running`/`incomplete` sessions (no `SessionEnd` fired) from their CouchDB chunks and/or the S3 transcript → write the missing `summary:<id>`. | planned | #4 |
| **export / import** | Dump (`export`) and restore (`import`) an instance (or a session / date range) as a portable bundle — summary + event docs + chunks + S3 blobs, plus the schema version — for moving history between machines or replacing an instance. | exists — `packages/cli/src/commands/{export,import}.ts` ([bundles.md](../design/bundles.md)) | — |
| **migrate** | Self-built CouchDB migrations: version the schema, migrate docs **up/down**, and create/update/remove design views. CouchDB has no modern migrations tool, so we build our own. | exists — `packages/cli/src/commands/migrate.ts` (seven view migrations applied) | [migrations.md](migrations.md), [ADR 0021](../design/decisions/0021-self-built-couchdb-migrations.md) |

### One `backfill` command (#6)

There is a **single** `backfill` command (an earlier design split it into a
summary-only pass and a full-parity *intake* pass, since merged). It does the
full-parity job in one pass: it writes the **summary doc + per-event marker docs +
full-content `chunk` docs** so a backfilled session matches a live-recorded one,
rather than a thin summary-only record. Provenance is explicit — backfilled
summaries carry `source: "backfill"` + `backfilled_at`, distinct from the
`source: "live"` the hook writes — and the transcript's real timestamps are
preserved. Subagent sub-transcript capture is the remaining gap, tracked in issue #6
(planning).

#### Re-processing an adopted session (`--force`)

By default `backfill` skips any session that already has a summary doc, which makes
repeat runs cheap. It also used to make some sessions permanently un-fixable: one
adopted with `--no-content`, or by a CLI old enough to write byte-range-only chunks,
had no path back to full-content chunks except deleting its docs by hand.

`--force` re-processes instead of skipping — optionally narrowed to one session with
`--session <id>`. It **deletes the session's derived docs first** (`DELETE
/api/ingest/{id}`), which is not an optimisation but a correctness requirement:
re-ingesting over the top would leave the old data in place, because event docs get
CouchDB-assigned ids and would duplicate, while chunk ids are keyed by byte offset — so
a session re-chunked at different boundaries keeps its old chunks alongside the new and
reads back doubled.

What it never deletes is the S3 transcript (it is overwritten) or the on-disk JSONL. So
a `--force` run interrupted between the delete and the rewrite leaves the session
incomplete but never unrecoverable: run it again.

Search is the one thing not fixed automatically. Re-ingest overwrites the entries it
regenerates, but turns belonging to chunks that no longer exist stay indexed until a
rebuild — so a forced run ends by telling you to run `claude-transcripts reindex`, the
documented reconciliation step for deletes ([ADR 0009](../design/decisions/0009-meilisearch-search.md)).

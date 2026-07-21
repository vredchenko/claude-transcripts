# @claude-transcripts/cli

The user-facing CLI + admin utility. Optional interface — everything it does is
reachable via the webapi; handy for humans and for AI agents driving the system
headless. Built with **Bun + Ink**.

**Aggregate of internal modules** (docs/cli.md), composed under one command:

- `src/cli.tsx` — entry + dispatch. Runnable data commands execute via the
  `src/commands` registry; anything else renders the Ink help (`src/app.tsx`,
  rendered from `CLI_SPEC`).
- `src/commands/` — runnable commands. **`backfill`** (history adoption from
  `~/.claude`); reconcile / export / import / migrate next.
- `src/lib/` — internal modules:
  - `claude-fs.ts` — the host-side `~/.claude/` reader (discover + read transcripts).
  - `transcript.ts` — parse JSONL → `SessionFacts` (reuses `@claude-transcripts/shared`
    `sumTranscriptTokens` for matching token math).
  - `session-docs.ts` — build the `summary`/`event` docs (schema parity with the
    hook; TODO: promote shapes to `@claude-transcripts/shared`).
  - `sink.ts` — delivery target: `DryRunSink` + `WebapiSink` (writes go *through*
    the webapi gateway — ADR 0016 — never the backends directly).
  - `args.ts` — minimal flag parser.
- `src/api/` *(planned)* — the **generated** webapi client (orval, `bun run
  gen:clients`); the `WebapiSink` adopts it once the OpenAPI spec + ingest routes
  land. Never hand-written.

## Data commands

```bash
claude-transcripts backfill [--dir <path>] [--host <name>] [--actor <who>] [--webapi <url>] [--dry-run]
```

A single **`backfill`** command adopts on-disk `~/.claude` transcripts as first-class
history: for each session it reconstructs the `summary:<id>` doc **and** per-event
marker docs (and, **planned**, `chunk` docs), so a backfilled session matches a
live-recorded one — no summary-only shortcut. It's **idempotent** and
**`--dry-run`**-able (docs/tools.md). Backfilled summaries carry `source: "backfill"` +
`backfilled_at` (vs the hook's `source: "live"`), and the transcript's real per-entry
timestamps are preserved. Subagent sub-transcript capture + chunk-doc
reconstruction are the remaining TODOs (see #6/#7).

> **Write path:** the `WebapiSink` posts to the webapi's curated ingest routes
> (`POST /api/ingest/{summary,events}`, `PUT /api/ingest/{id}/transcript` —
> `packages/webapi/src/routes/ingest.ts`). A real run needs a reachable webapi with
> the `sessions` DB + bucket provisioned; otherwise use `--dry-run` to preview.

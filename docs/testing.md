# Testing

> **Status: landed (Tier-1 scope).** The e2e harness (`tests/e2e/`) drives
> synthesized sessions — baseline, large multi-chunk, and subagent-sidechain —
> through the real write→store→read path and self-skips when the stack is down;
> the CLI `doctor` command is the interactive single-session equivalent. Unit
> specs cover the pure cores (`sumTranscriptTokens`, chunk tiling, the migration
> engine up/down round-trip). Remaining: e2e cases for resumes / crashed
> (`incomplete`) sessions / `backfill` parity, and the contract check. The suite is
> the **milestone between Tier 1 and Tier 2** ([tiers.md](tiers.md)).

## End-to-end suite (T1 → T2 gate)

A suite that **fakes a Claude Code session and drives the whole system
end-to-end**, exercising the real write→store→read path without needing an actual
Claude Code instance:

1. **Fake a session** — synthesize the hook event stream (`SessionStart` →
   `UserPromptSubmit` / `PostToolUse` / `PostToolUseFailure` / `Stop` …→
   `SessionEnd`) and a transcript JSONL, the way Claude Code would emit them.
2. **Drive the writers** — run the hook (or post through the webapi gateway) so
   event markers, chunks, the summary, and the S3 blobs are written.
3. **Assert through the reader** — query the webapi (`/api/claude/sessions`,
   detail, transcript, `/api/couch` views, `/api/s3` blobs) and assert the session
   appears correctly: counts, token usage, tool usage, status transitions
   (`running` → `ended`), transcript round-trip.
4. **Run against the bundled stack** — the repo's own CouchDB + Garage +
   Meilisearch on the dev port range (no-auth, [configuration.md](configuration.md)),
   isolated from any other services on the host.

`hooks/scripts/smoke-test.ts` is the seed of this — it already seeds one synthetic
session through the write path and asserts the views. The e2e suite generalises it
into a fuller, multi-scenario harness (resumes, crashes/incomplete sessions,
subagents, chunked content, `backfill` parity).

## Other test layers (placeholder)

- **Unit** — `sumTranscriptTokens` (done — `packages/shared/src/index.test.ts`;
  to be validated against `ccusage` as an oracle too), chunk offset tiling (done),
  plus pruning + config overlay (pending).
- **Contract** — the generated API clients ([ADR 0019](decisions/0019-openapi-source-of-truth-generated-clients.md))
  give the webui/CLI a typed boundary; assert the OpenAPI spec stays compatible
  (pending).
- **Migration** — up/down round-trips **done** (in-memory port fake,
  `packages/shared/src/migrations/runner.test.ts`); export→import
  (migrate-on-import) bundle round-trips pending ([migrations.md](migrations.md)).

> Per the repo's operating constraints, nothing is run on the live homeserver
> during development of the spec; the suite is authored to run in CI / on a dev
> box against the bundled stack.

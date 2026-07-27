# hooks/ — the writer

The Claude Code plugin that logs every session to CouchDB + S3. Installs
separately, per machine (not part of the webapi/webui runtime image).

**Model-driven.** The hook is a standalone plugin (it can't import the workspace),
so the app model's hook→action bindings are **codegen'd into it** by
`scripts/sync-hooks.ts` (`bun run gen:hooks`):

- `hooks/hooks.json` — the Claude Code events to register (generated).
- `scripts/bindings.generated.json` — `event → action keys`, read by the
  dispatcher (generated).

Re-run `gen:hooks` after changing the model's `BINDINGS` (in `@claude-transcripts/shared`).

## Layout

- `.claude-plugin/plugin.json` — plugin manifest.
- `scripts/dispatch.ts` — single entry point; routes an event to its **actions**
  via `bindings.generated.json`, runs `handlers/<action>.ts`. Never blocks.
- `scripts/handlers/<action>.ts` — one handler per **action key** (matches the
  model's action catalogue): `seed-session-start`, `write-event-marker`,
  `update-counts`, `flush-transcript-chunk`, `write-summary`, `upload-blobs`.
- `scripts/lib/*` — config + context (CouchDB client, S3 blob client, per-session
  counts, chunk state).
- `scripts/transcript-tokens.ts` — **byte-identical** copy of `@claude-transcripts/shared`'s
  `sumTranscriptTokens` (the hook can't resolve the workspace) — change both.

> Handlers are implemented: `seed-session-start` (SessionStart marker),
> `write-event-marker` + `update-counts` (per-event), `flush-transcript-chunk`
> (mid-flight chunking), `write-summary` (SessionEnd rollup + token usage → CouchDB
> and S3), `upload-blobs` (transcript → S3). All CouchDB/S3 calls are wrapped so the
> hook **never blocks a session**. Still open: full mid-flight chunking polish and
> secrets masking (see docs/design/mid-flight-chunking.md, roadmap #4/#11).

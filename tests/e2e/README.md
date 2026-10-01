# End-to-end suite

Fakes a Claude Code session and drives the **whole write → store → read path**
through the real webapi gateway (ingest → CouchDB + S3, then the reader
endpoints), asserting the session reads back with correct rollups, token usage,
tool counts, status, and a full transcript round-trip. This is the Tier-1 → Tier-2
gate ([../../docs/develop/testing.md](../../docs/develop/testing.md)).

- **`synth.ts`** — the session synthesizer. Builds a transcript JSONL plus the
  derived `summary` / `event` / `chunk` docs for one session, computing the
  expected numbers with the *real* shared helpers (`sumTranscriptTokens`,
  `sliceIntoChunks`, `chunkDocId`) so they can't drift from the app's accounting.
  Parameterised by `prompts`, `tools`, `errors`, and `sidechains`.
- **`e2e.test.ts`** — POSTs those through the webapi and asserts via the reader,
  across four scenarios: a **baseline** session, a **large** session that spans
  more than one transcript chunk, one with **subagent (sidechain)**
  sub-transcript entries (counted in the transcript, absent from the rollups), and
  an **incomplete** session (events + transcript, no summary) that must still
  surface. It also checks that re-ingesting a summary is idempotent.

For an interactive single-session smoke test of the same path, use the CLI:
`claude-transcripts doctor` (see `packages/cli`).

## Running

`bunfig.toml` scopes default `bun test` discovery to `packages/` (unit specs), so
run the e2e suite by explicit path:

```bash
bun run stack:up:upstream   # bundled CouchDB + Garage + Meilisearch (+ admin UIs)
bun run dev:webapi          # webapi gateway on :7650  (separate shell)
bun run test:e2e            # === bun test ./tests/e2e/*.test.ts
```

Point at a different gateway with `CT_WEBAPI_URL`. The suite **self-skips** (it
does not fail) when the webapi is unreachable, so it is safe to run in any
environment. CI has no stack, so doesn't run it — run it locally when touching the
write or read path.

## Scenario coverage

Still to add: resumes and `backfill` parity — each a new `synth*` variant through the
same assertions.

# End-to-end suite

Fakes a Claude Code session and drives the **whole write → store → read path**
through the real webapi gateway (ingest → CouchDB + S3, then the reader
endpoints), asserting the session reads back with correct rollups, token usage,
tool counts, status, and a full transcript round-trip. This is the Tier-1 → Tier-2
gate ([../../docs/testing.md](../../docs/testing.md)).

- **`synth.ts`** — the session synthesizer. Builds a transcript JSONL plus the
  derived `summary` / `event` / `chunk` docs for one session, computing the
  expected numbers with the *real* shared helpers (`sumTranscriptTokens`,
  `sliceIntoChunks`, `chunkDocId`) so they can't drift from the app's accounting.
  Parameterised by `prompts`, `tools`, `errors`, and `sidechains`.
- **`e2e.test.ts`** — POSTs those through the webapi and asserts via the reader,
  across three scenarios: a **baseline** session, a **large** session that spans
  more than one transcript chunk, and one with **subagent (sidechain)**
  sub-transcript entries (counted in the transcript, absent from the rollups).

For an interactive single-session smoke test of the same path, use the CLI:
`claude-transcripts doctor` (see `packages/cli`).

## Running

`bunfig.toml` scopes default `bun test` discovery to `packages/` (unit specs), so
run the e2e suite by explicit path:

```bash
bun run stack:up        # bundled CouchDB + Garage (+ admin UIs), dev port range
bun run dev:webapi      # webapi gateway on :7650  (separate shell)
bun run test:e2e        # === bun test tests/e2e
```

Point at a different gateway with `CT_WEBAPI_URL`. The suite **self-skips** (it
does not fail) when the webapi is unreachable, so it is safe to run in any
environment; CI runs it against the dev stack.

## Scenario coverage

Done: baseline, large multi-chunk content, subagent sidechain entries. Still to
add: resumes, crashed/`incomplete` sessions (needs the reader to surface
sessions with no `summary` doc — see the TODO in `routes/sessions.ts`), and
`backfill` parity (adopted on-disk history matching live-recorded shape). Each is
a new `synth*` variant or option fed through the same assertions.

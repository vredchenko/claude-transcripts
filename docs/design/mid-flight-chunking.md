# Notes — mid-flight transcript chunking (issue #4, P1)

> **Status: implemented, including full-content chunks.** The shared byte-faithful
> slicer (`@claude-transcripts/shared` `sliceIntoChunks` — one copy, imported directly
> since the CLI became the hook) is live: `backfill` reconstructs `chunk`
> docs, and the hook's `flush-transcript-chunk` tails the transcript incrementally
> (byte-offset + lock state in `/tmp`, gated behind `features.midFlightChunking`).
> Both produce identical byte boundaries. With `couchFullContentChunks` on, both also
> embed the pruned `entries[]`, and the webapi reads turns from them
> ([ADR 0027](decisions/0027-full-content-chunks-in-couchdb.md)). **Still deferred:**
> the content-feature views (`features/urls` and friends).

Working notes for the logging rework; the decision is
[ADR 0027](decisions/0027-full-content-chunks-in-couchdb.md) (narrows 0014). These
notes keep the design detail.

## What changed

Until now everything durable happened at `SessionEnd`: the summary doc + the S3
transcript upload. If a session crashed / was killed / the machine rebooted before
`SessionEnd`, the content was lost and the session was stuck `running` forever.

Now the hook **tails the live transcript file mid-session** and writes append-only
`chunk:` docs to CouchDB as the session runs. The full byte-faithful transcript is
still uploaded to S3 at `SessionEnd` (unchanged). Couch chunks make the content
queryable by map-reduce views and give crash resilience (worst case = lose the last
un-flushed delta, not the whole session).

## Key enabling facts

- `transcript_path` is a **common Claude Code hook input field on every event**, not
  just `SessionEnd`. The transcript is written incrementally as JSONL during the
  session, so any mid-session handler can read it.
- We read the transcript **from the filesystem** (`transcript_path`) — the granular
  event hooks stay light markers; the rich content comes from parsing the file.

## Design (as built)

- **Trigger:** the `flush-transcript-chunk` action runs on `UserPromptSubmit`,
  `PostToolUse`, `PostToolUseFailure`, and `Stop` (bound alongside the other per-event
  actions in the app model). A final flush runs at `SessionEnd`.
- **Tail + offset:** the hook runtime reads new bytes from the last offset
  to EOF, consuming only **complete `\n`-terminated lines** (a partial trailing line
  is left for next time so we never split a JSON record). Offset state lives in
  `/tmp/claude-transcripts-<sessionId>.chunkstate` (`{ offset, lastFlushMs }`), guarded by
  a sibling `.chunklock` so concurrent hook processes can't interleave a flush.
  `/tmp` loss is recoverable — S3 still has the full transcript.
- **Batch policy:** flush when buffered entries ≥ `logging.chunk.maxEntriesPerChunk`
  (200) **or** `logging.chunk.flushIntervalMs` (15000ms) since the last flush —
  whichever first. `Stop` and `SessionEnd` always force a flush. Below the threshold
  the offset is **not** advanced (the delta waits in the file).
- **Concurrency:** hook events spawn separate processes that race on the offset. A
  `O_EXCL` lockfile (`/tmp/claude-transcripts-<sessionId>.chunklock`, stale after 30s) guards the
  read→write→advance critical section; if the lock is held the flush is **skipped**
  and the delta is caught on the next flush / at `SessionEnd`.
- **Chunk doc** (`chunk:<sessionId>:<byteStart padded to 12>`):
  ```jsonc
  {
    "type": "chunk", "session_id": "<cc id>",
    "byte_start": 10240, "byte_end": 10752, "entry_count": 8,
    "timestamp": "…", "hostname": "…", "cwd": "…", "source": "live",
    "schema_version": 2, // 1 for a byte-range-only chunk (no entries)
    "entries": [ /* parsed, pruned JSONL entries — only when couchFullContentChunks */ ]
  }
  ```
  The id is keyed on `byte_start` (monotonic, unique per session) rather than a
  sequence counter, so it never collides across resumes even if `/tmp` state was lost.
- **Append-only, no mutation.** Lifecycle stays *derived*: `SessionStart` event +
  presence of `summary:<id>` ⇒ ended; chunks-but-no-summary ⇒ running/incomplete.
- **Pruning**: placeholder only — truncate oversized string fields
  and drop base64 image data, leaving a marker. Real policy is a later issue (ties to
  secrets masking #11). S3 keeps the un-pruned master.
- **Resumes:** on `SessionStart` with `source` `startup`/`clear`, offset resets to 0.
  On `resume`/`compact` with no `/tmp` state, offset starts at the current file size
  (prior content was already chunked in the earlier run of the same session id).

## Feature flags (`features.*` in the app config, both default `true`)

- `features.midFlightChunking` — master switch for the `flush-transcript-chunk`
  handler. Off ⇒ nothing is chunked mid-session; only the `SessionEnd` summary + S3
  upload run.
- `features.couchFullContentChunks` — when on, chunk docs carry the `entries` content;
  when off, they're light markers (offsets + counts only).

To change them, edit the instance's `app.json` (`~/.config/claude-transcripts/`) or
`config/config.json` in a checkout, then re-run `install` / `setup`.

## Views (added through a migration — `packages/shared/src/migrations/`)

- `chunks/by_session` — `[session_id, byte_start] → {byte_start, byte_end, entry_count}`
  for ordered reassembly of a session's content from its chunks.
- `chunks/entry_count_by_session` — `session_id → Σ entry_count` (`_sum`): how much
  content was chunked into Couch for a session.
- `chunks/entries_by_session` and the `speaker_split` views read the embedded
  `entries[]` (per-turn reads, [ADR 0027](decisions/0027-full-content-chunks-in-couchdb.md)).
- `features/urls` (and other content-feature views) is **deferred to the fast-follow**
  — a regex map view can't be validated here without running CouchDB, so it isn't
  committed in this pass.

Dedup of the streaming/duplicate assistant messages is left to **read/view time**
(mirror `sumTranscriptTokens`' heaviest-usage-per-message-id rule) — chunks stay
byte-faithful to their slice, which keeps them append-only and replication-safe.

## Done in this pass

- the byte-faithful slicer + chunk state in `@claude-transcripts/shared` and the hook
  runtime (`packages/cli/src/hook/runtime.ts`)
- the `flush-transcript-chunk` action and its model bindings
- `seed-session-start` (reset/seed offset) and the `SessionEnd` final flush +
  `/tmp` cleanup
- the `_design/chunks` design doc, installed by the migration registry (one definition)

## Not done yet (follow-ups)

- **Reconciliation sweep** for stale `running` sessions (chunks/S3 → summary) — fold
  into the `backfill` tool (#6) or a light `SessionStart` sweep.
- **Feature-view route** once the feature views exist.
- **Feature views**: `features/urls` first (validate the regex map against CouchDB),
  then repos/PRs/issues/`/`-commands/models.
- **Test the hook's live `flush-transcript-chunk`** (`doctor` covers chunk docs via
  ingest only).

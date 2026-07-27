# Notes — mid-flight transcript chunking (issue #4, P1)

> **Status: implemented (metadata chunks).** The shared byte-faithful slicer
> (`@claude-transcripts/shared` `sliceIntoChunks`, byte-identical copy in
> `hooks/scripts/transcript-chunks.ts`) is live: `backfill` reconstructs `chunk`
> docs, and the hook's `flush-transcript-chunk` tails the transcript incrementally
> (byte-offset + lock state in `/tmp`, gated behind `features.midFlightChunking`).
> Both produce identical byte boundaries. **Still deferred:** embedding the pruned
> `entries[]` when `couchFullContentChunks` is on (chunks are metadata-only for
> now), and the time-based flush's content-view fast-follow.

Working notes for the logging rework. **In place of an ADR for now** (owner deferred
the ADR — see issue #4 thread). When the dust settles this should be promoted to an
ADR superseding **0014** ("transcripts live in S3 only"), because it deliberately
changes that: CouchDB now also carries transcript *content* (chunked), while S3
remains the byte-faithful escrow.

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

- **Trigger:** a new `chunk-flush` handler runs on `UserPromptSubmit`, `PostToolUse`,
  `PostToolUseFailure`, and `Stop` (registered alongside the existing per-event
  handlers in `dispatch.ts`). A final flush runs at `SessionEnd`.
- **Tail + offset:** `lib/transcript-chunks.ts` reads new bytes from the last offset
  to EOF, consuming only **complete `\n`-terminated lines** (a partial trailing line
  is left for next time so we never split a JSON record). Offset state lives in
  `/tmp/claude-transcripts-<sessionId>.chunk` (`{ offset, lastFlushMs }`), the same `/tmp` pattern
  as `lib/counts.ts`. `/tmp` loss is recoverable — S3 still has the full transcript.
- **Batch policy:** flush when buffered entries ≥ `logging.chunk.maxEntriesPerChunk`
  (200) **or** `logging.chunk.flushIntervalMs` (15000ms) since the last flush —
  whichever first. `Stop` and `SessionEnd` always force a flush. Below the threshold
  the offset is **not** advanced (the delta waits in the file).
- **Concurrency:** hook events spawn separate processes that race on the offset. A
  `O_EXCL` lockfile (`/tmp/claude-transcripts-<sessionId>.chunk.lock`, stale after 30s) guards the
  read→write→advance critical section; if the lock is held the flush is **skipped**
  and the delta is caught on the next flush / at `SessionEnd`.
- **Chunk doc** (`chunk:<sessionId>:<byteStart padded to 12>`):
  ```jsonc
  {
    "type": "chunk", "session_id": "<cc id>",
    "byte_start": 10240, "byte_end": 10752, "entry_count": 8,
    "timestamp": "…", "hostname": "…", "cwd": "…", "schema_version": 1,
    "entries": [ /* parsed, pruned JSONL entries — only when couchFullContentChunks */ ]
  }
  ```
  The id is keyed on `byte_start` (monotonic, unique per session) rather than a
  sequence counter, so it never collides across resumes even if `/tmp` state was lost.
- **Append-only, no mutation.** Lifecycle stays *derived*: `SessionStart` event +
  presence of `summary:<id>` ⇒ ended; chunks-but-no-summary ⇒ running/incomplete.
- **Pruning** (`lib/prune.ts`): placeholder only — truncate oversized string fields
  and drop base64 image data, leaving a marker. Real policy is a later issue (ties to
  secrets masking #11). S3 keeps the un-pruned master.
- **Resumes:** on `SessionStart` with `source` `startup`/`clear`, offset resets to 0.
  On `resume`/`compact` with no `/tmp` state, offset starts at the current file size
  (prior content was already chunked in the earlier run of the same session id).

## Feature flags (in `claude-transcripts.config.json`, both default `false`)

- `features.midFlightChunking` — master switch for the `chunk-flush` handler. Off ⇒
  exact current behaviour (nothing new runs).
- `features.couchFullContentChunks` — when on, chunk docs carry the `entries` content;
  when off, they're light markers (offsets + counts only).

To enable in a deployment, set both `true` in the runtime config and re-run
`hooks/scripts/setup.sh` (it bakes `claude-transcripts.config.json` into the hook runtime config).

## Views (added to BOTH mirrors — `hooks/couchdb/.../designs/` and `ensure.ts`)

- `chunks/by_session` — `[session_id, byte_start] → {byte_start, byte_end, entry_count}`
  for ordered reassembly of a session's content from its chunks.
- `chunks/entry_count_by_session` — `session_id → Σ entry_count` (`_sum`): how much
  content was chunked into Couch for a session.
- `features/urls` (and other content-feature views) is **deferred to the fast-follow**
  — a regex map view can't be validated here without running CouchDB, so it isn't
  committed in this pass.

Dedup of the streaming/duplicate assistant messages is left to **read/view time**
(mirror the `transcript-tokens.ts` heaviest-usage-per-message-id rule) — chunks stay
byte-faithful to their slice, which keeps them append-only and replication-safe.

## Done in this pass

- `lib/chunk-state.ts`, `lib/prune.ts`, `lib/transcript-chunks.ts`
- `handlers/chunk-flush.ts` + `dispatch.ts` REGISTRY wiring
- `handlers/session-start.ts` (reset/seed offset), `handlers/session-end.ts` (final
  flush + `/tmp` cleanup)
- design doc `chunks.json` (hook mirror) + the `chunks` design in `ensure.ts` (webapi mirror)

## Not done yet (follow-ups)

- **Reconciliation sweep** for stale `running` sessions (chunks/S3 → summary) — fold
  into the `backfill` tool (#6) or a light `SessionStart` sweep.
- **Reader**: webapi serving a partial/live transcript from chunks for still-running
  sessions + a feature-view route; webui live indicator.
- **Feature views**: `features/urls` first (validate the regex map against CouchDB),
  then repos/PRs/issues/`/`-commands/models.
- **smoke-test.ts** coverage for the chunk path.
- **Promote these notes to an ADR** superseding 0014, and keep the
  `sumTranscriptTokens` byte-identical-copy invariant in mind if any parsing is shared.

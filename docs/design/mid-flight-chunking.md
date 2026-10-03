# Mid-flight chunking

The hook copies the transcript into CouchDB `chunk` docs while the session runs, rather
than only at `SessionEnd`. A crashed or killed session loses at most the last unflushed
delta instead of everything, and a running session's transcript can be read and
searched. The byte-exact transcript still goes to S3 at `SessionEnd`. Decision:
[ADR 0027](decisions/0027-full-content-chunks-in-couchdb.md), which narrows
[ADR 0014](decisions/0014-transcripts-live-in-s3-only.md).

Every hook payload carries `transcript_path`, and Claude Code writes the transcript as
JSONL as it goes, so any event can read it from disk. Event docs stay small markers;
content comes from the file.

## How a flush works

- **When:** `flush-transcript-chunk` runs on `UserPromptSubmit`, `PostToolUse`,
  `PostToolUseFailure` and `Stop`, plus a final flush at `SessionEnd`.
- **What:** bytes from the stored offset to the end of the file, whole
  newline-terminated lines only; a partial last line waits for the next flush.
- **Batching:** flush once `system.logging.chunk.maxEntriesPerChunk` (200) entries are
  buffered or `flushIntervalMs` (15 s) has passed since the last flush. `Stop` and
  `SessionEnd` always flush. Below the threshold the offset doesn't move.
- **State:** `/tmp/claude-transcripts-<sessionId>.chunkstate` (`{ offset, lastFlushMs }`).
  Each hook event is a separate process, so the read → write → advance step holds an
  `O_EXCL` lock file (`.chunklock`, stale after 30 s). If the lock is taken, the flush
  is skipped and the next one catches up.
- **Doc:** `chunk:<sessionId>:<byte_start padded to 12>`, shaped as in
  [couchdb.md](../reference/couchdb.md#chunk). Keying on the byte offset keeps ids
  unique across resumes and makes a re-flush replace rather than duplicate.
- **Pruning:** oversized strings are truncated and base64 images dropped, leaving a
  marker. S3 keeps the unpruned original. A real pruning policy is tied to secrets
  masking (#11).

Chunks are not deduplicated: Claude Code writes several entries per streamed message,
and merging them (by `message.id`, as `sumTranscriptTokens` does) is a read-time job.
Keeping each chunk faithful to its slice keeps chunks append-only.

## Resumes

On `SessionStart` with `source` `startup` or `clear`, the offset resets to 0. On
`resume` or `compact` it carries over: `SessionEnd` releases the lock but keeps the
state file. If the state is gone (a reboot cleared `/tmp`), the hook asks CouchDB for
the highest `byte_end` among the session's chunks (`_all_docs` over the
`chunk:<sessionId>:` prefix, descending, limit 1) and continues from there; if CouchDB
doesn't answer within 2 s, it starts at 0. An offset past the end of the file (a
rewritten transcript) is never used. Restarting at 0 on a resume re-slices the
transcript on new boundaries with new ids, duplicating content
([#168](https://github.com/vredchenko/claude-transcripts/issues/168)), which is why the
offset is recovered.

## Flags

Both default on, in `features` ([configuration.md](../start/configuration.md#settings)):

- `midFlightChunking` — off: nothing is chunked during the session; only the summary
  and the S3 upload at `SessionEnd`.
- `couchFullContentChunks` — off: chunks carry offsets and counts only, no `entries`.

Change them in `config/config.json` (or the instance's `app.json`) and re-run `setup`
or `install`.

## Not done

- Feature views (`features/urls`, then repos, PRs, issues, slash commands, models).
- `reconcile` for sessions that never reached `SessionEnd`
  ([roadmap.md](roadmap.md)).

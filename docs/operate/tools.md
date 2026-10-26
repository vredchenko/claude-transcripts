# Backfill

`backfill` adopts the transcripts Claude Code already keeps on disk
(`~/.claude/projects/**/<id>.jsonl`) as first-class history: sessions from before you
installed, or from while the stack was down.

```bash
claude-transcripts backfill --dry-run                   # preview: adopt / skip / repair per session
claude-transcripts backfill                             # adopt everything not already stored
claude-transcripts backfill --force --session <id>      # rebuild one adopted session
claude-transcripts backfill --repair                    # finish sessions an interrupted write left short
```

All flags: [cli.md](../reference/cli.md#backfill-options).

## What it writes

For each session, the same shape a live recording has, delivered through the webapi's
`/api/ingest/*` routes (indexed for search within `system.search.flushIntervalMs`, 3 min
by default, like any other write):

- the `summary:<id>` doc, with `source: "backfill"` and `backfilled_at`;
- one `event` doc per reconstructed hook event;
- full-content `chunk` docs (byte-range only with `--no-content`);
- the transcript blob in S3.

Timestamps are the transcript's own, never the time of the backfill. `--host` and
`--actor` set attribution. Token usage is computed with the same
`sumTranscriptTokens` the hook uses, so counts match a live recording.

Not captured yet: subagent sub-transcripts. The run reports how many sessions have
them.

## Re-running

- **Default** — sessions that already have a summary doc are skipped, so repeat runs
  are cheap.
- **`--dry-run`** reads the store and writes nothing, so the preview shows exactly what
  a real run would skip. If the webapi is unreachable it says the preview is a guess.
- **`--force`** re-processes adopted sessions, for example ones adopted with
  `--no-content` or by an older CLI that wrote byte-range-only chunks. It first deletes
  the session's derived docs (`DELETE /api/ingest/{id}`): re-ingesting over the top
  would duplicate event docs (their ids are assigned by CouchDB) and leave old chunks
  beside new ones (chunk ids are byte offsets). The S3 transcript and the on-disk JSONL
  are never deleted, so an interrupted `--force` is fixed by running it again.
  Afterwards, run `claude-transcripts reindex` to drop search entries for chunks that
  no longer exist.
- **`--replace-live`** — `--force` refuses live-recorded sessions, whose `end_reason`,
  model, token usage and per-event markers a transcript can't reproduce. Add this flag
  to rebuild them anyway.
- **`--repair`** — for an adopted session with no readable turns, or whose transcript
  never reached S3 (a cancelled `SessionEnd`): adds the missing chunks or blob and
  leaves the summary and events alone. It refuses running sessions and sessions that
  already have turns.

## reconcile

A session killed or crashed before `SessionEnd` has its event markers and chunks but
no `summary:<id>`, so it reads as `incomplete` with no token totals. `reconcile` writes
the summary it never got:

```
claude-transcripts reconcile                  # every session that reads as incomplete
claude-transcripts reconcile <id>… [--force]  # these sessions; --force also takes a running one
claude-transcripts reconcile --dry-run --json
```

- **Counts** (events, prompts, errors, tools) are the session's recorded event markers,
  the same figures the session list already showed, so they don't move.
- **Token usage and transcript size** come from the S3 transcript when there is one.
  Without one (S3 off, or the upload never happened) the summary has no token figures
  rather than zeros. If S3 is on but doesn't answer, the session fails and is left for
  the next run, because a summary written without tokens would stay that way.
- `timestamp` is the session's last activity and `end_reason` is `unknown`;
  `source: "reconcile"` and `reconciled_at` record how and when.
- It reads and writes through the webapi (`/api/ingest/summary`), and skips sessions
  that already ended. If a reconciled session is later resumed, its live `SessionEnd`
  replaces the reconciled summary. Between the resume and that `SessionEnd`, the
  session reads as `ended`.

**Automatically:** the webapi's change follower runs the same command every hour on up
to 50 sessions that read as `incomplete` (`system.sessions.reconcile`,
[configuration.md](../start/configuration.md)). It needs the CLI beside the webapi; the
app image ships it. A session the command fails on isn't retried until the webapi
restarts.

## Not built

- `couch` / `s3` power-user passthroughs and `meta post` enrichment.

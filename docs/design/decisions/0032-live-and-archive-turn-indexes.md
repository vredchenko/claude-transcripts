# 32. Live and archive turn indexes

Date: 2026-11-01

## Status

Accepted. Amends the indexing half of [ADR 0009](0009-meilisearch-search.md).

## Context

Conversation turns were one Meilisearch index, kept current by the `_changes`
follower. Meilisearch's cost is per update, not per document, and an update rewrites a
share of the index proportional to its size: about 17 MB of disk writes per document on
a 1 GB index (#231). A running session is a steady stream of small updates, so the cost
of keeping search fresh grew with the size of the whole history.

The fix in #231 was to buffer changes and flush every three minutes. That cut the
number of updates but not their price, and traded freshness for it.

Most of the corpus doesn't change. Once a session ends, its turns are final, so only
the running sessions' turns need frequent writes, and those are a small fraction of
the total.

## Decision

Split the turns into two indexes, and search them as one.

- **Archive** (`meilisearch.indexes.turns`): every turn of every session that is over.
  It keeps the existing config key, so an upgrading deployment's index becomes the
  archive. It is written only by **promotion** and by `reindex`.
- **Live** (`meilisearch.indexes.liveTurns`): turns of sessions still running. Small,
  so the follower writes it often (`system.search.flushIntervalMs`, 20 s).

A session's turns belong in the live index while it is `running` (no summary, active
within `system.sessions.liveWindowMs`), and in the archive once it has a summary of any
provenance (`live`, `reconcile`, `backfill`) or has gone quiet past the window.

**Promotion** runs on a slow clock (`system.search.archiveIntervalMs`, 15 min). It
batches every session that became archivable since the last pass, reads their turns
from CouchDB, adds them to the archive, waits for Meilisearch to confirm, and only then
deletes them from the live index. Adding first means the worst case is a moment in
both indexes, which search de-duplicates by turn id, never a moment in neither. A
batch the archive rejects stays live and is retried.

The same pass asks the live index which sessions it holds (a facet on `sessionId`) and
promotes any that no longer belong there. That recovers promotions lost to a restart,
and settles sessions that went quiet without ending. Every
`system.search.liveRebuildIntervalMs` (1 h) it also rebuilds the live index from
CouchDB, as a backstop for rows a failed flush dropped. Flushes, promotions and
rebuilds share one queue, so none of them can overlap another.

**Search** sends the query to both turn indexes as one federated multi-search
(Meilisearch 1.10+): one ranking, one page across both. They share settings, so their
ranking scores are comparable. The sessions index is not split: it holds one row per
session, so it stays small, and facets — which federated search in 1.10 can't merge —
keep coming from it alone.

**Rebuilds swap instead of clearing.** `reindex` and the live rebuild fill a side index
(`<name>-rebuild`) and swap it in, so search answers from the old contents until the
new ones land, and a rebuild that fails leaves the index as it was.

## Alternatives considered

- **A longer flush interval on one index.** This is the #231 approach taken further: it
  makes search staler without making an update cheaper.
- **Re-indexing the whole archive when a session ends.** This costs the most each time,
  and the event happens hundreds of times a day. Appending one session's turns does the
  same job.
- **Splitting the sessions index too.** It is one row per session, so there's little
  to save, and splitting it would need merged facets, which needs a newer Meilisearch.

## Consequences

- Writes to the large index scale with the number of sessions that end, batched, rather
  than with the number of hook events. Live search is fresher (seconds instead of
  minutes).
- An ended session's turns stay in the live index for up to one promotion interval.
  They are searchable throughout.
- A session resumed after its summary was written stays in the archive; its new turns
  join it at the next pass rather than within seconds.
- Upgrading needs one `reindex`: until then the archive still holds the turns of
  sessions that were running at upgrade time, which search shows once (de-duplicated)
  but which nothing removes from the archive.
- An external Meilisearch must be 1.10 or later
  ([ADR 0028](0028-external-vs-bundled-meilisearch.md)).
- A third index name to keep distinct on a shared engine, plus its `-rebuild` side
  index.

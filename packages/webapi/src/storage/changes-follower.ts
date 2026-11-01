/**
 * Follows CouchDB's `_changes` feed and keeps two readers current from it: the
 * in-memory session index, and the Meilisearch indexes.
 *
 * Indexing used to happen only as a side effect of `/api/ingest/*`, which left a hole:
 * the hook writes straight to CouchDB, so a live-recorded session was never searchable
 * until someone ran a manual reindex. Following the change feed closes that without
 * coupling the writer to the reader — whoever writes a doc, by whatever path, the
 * readers catch up. It also keeps the hook free of a hard dependency on the webapi
 * being up, which matters because the hook must never block a session.
 *
 * It now feeds the session index too (#107), which is why the feed runs even when
 * search is switched off: the change feed is the only thing that knows which sessions
 * moved, and that is exactly what makes re-reducing the whole corpus per request
 * avoidable. One feed, two consumers — a second follower would double the load on
 * CouchDB to learn the same facts.
 *
 * The index also says which sessions went quiet without ever ending, so the follower
 * runs the `reconcile-session` sweep too (`reconcile-sweep.ts`): one feed, and the one
 * place that already knows.
 *
 * Search updates are buffered and flushed every few seconds rather than sent per batch:
 * Meilisearch pays per update, not per document, and a live session is a stream of
 * one-document batches (#231). The session index, which is in memory, stays per batch.
 * Turns go to a small live index; a session's turns move to the large archive index
 * once it ends, on a much slower clock (ADR 0032).
 *
 * Scope, deliberately: **upserts only**. Docs here are append-only by invariant
 * ([ADR 0016]), so deletion is an out-of-band admin action; `POST /api/search/reindex`
 * stays the reconciliation step for deletes and for history written before search
 * existed. Everything is best-effort — a failure here must never take down the webapi.
 */

import { indexName } from "../config";
import type { AppContext } from "../context";
import {
  LIVE_TURNS_INDEX_KEY,
  LIVE_TURNS_INDEX_SETTINGS,
  SESSIONS_INDEX_KEY,
  TURNS_INDEX_KEY,
  toRunningSessionSearchDoc,
  toSessionSearchDoc,
  toTurnSearchDocs,
} from "./meili";
import { startReconcileSweep } from "./reconcile-sweep";
import { type SearchBatch, SearchBuffer } from "./search-buffer";
import {
  INDEX_BATCH,
  liveClassifier,
  loadSessionTurns,
  rebuildIndex,
  rebuildIndexName,
  sessionAggregates,
  sessionFilter,
} from "./turn-tiers";

/**
 * Doc id of the resume point, so a restart doesn't replay the whole feed.
 *
 * `_local/` is load-bearing rather than tidy: CouchDB excludes local documents from
 * `_changes` by design. Keeping the checkpoint as an ordinary doc in the database this
 * follower *follows* closed a feedback loop — the write was itself a change, the
 * longpoll returned at once with a batch holding nothing indexable, and the handler
 * checkpointed again. Nothing throttled it but CouchDB's round-trip time. One idle
 * instance reached 5.1M revisions of that single document at ~10 writes/sec, holding a
 * CPU core and a database file 78% larger than its live data (#89).
 *
 * Damping the loop (checkpoint only when a batch indexed something) would have left it
 * latent — a real batch still wakes the feed once more. `_local/` removes the edge
 * instead, and matches what a checkpoint already is: not replicated, and meaningless
 * outside this instance ([bundles.md](../../../../docs/design/bundles.md)).
 */
const CHECKPOINT_ID = "_local/search_checkpoint";
// Named for search because that is what first wrote it. Deliberately unchanged when
// this module grew a second consumer: the id *is* the persisted state, and renaming
// it would silently restart every existing instance's feed from `now`.

/** Where the resume point lived before #89, adopted and removed on the first run after. */
const LEGACY_CHECKPOINT_ID = "search_checkpoint";

/** The doc `type` both the local and the legacy checkpoint carry. */
const CHECKPOINT_TYPE = "search_checkpoint";

export interface ChangesFollower {
  /** Stop following, and resolve once anything buffered for search has been flushed. */
  stop(): Promise<void>;
}

/** The slice of a CouchDB database the checkpoint needs — see the tests' fake. */
export interface CheckpointStore {
  get(id: string): Promise<any>;
  insert(doc: any, docName?: string): Promise<any>;
  destroy(id: string, rev: string): Promise<any>;
}

/** The `seq` at `id`, or null when the doc is absent or holds nothing usable. */
async function readSeq(db: CheckpointStore, id: string): Promise<string | null> {
  try {
    const doc = await db.get(id);
    return typeof doc?.seq === "string" ? doc.seq : null;
  } catch {
    return null; // no checkpoint yet
  }
}

/**
 * Read the stored `_changes` sequence, or null when we've never followed before.
 *
 * An instance upgrading across #89 still has its position in the old ordinary doc.
 * Adopt it — restarting at `now` would silently skip everything written between that
 * checkpoint and this boot — then delete it, both so it stops waking the feed and so
 * compaction can reclaim the revision tree it grew while spinning. New checkpoint
 * first: a crash between the two costs a replay, the other order costs the position.
 */
export async function readCheckpoint(db: CheckpointStore): Promise<string | null> {
  const current = await readSeq(db, CHECKPOINT_ID);
  if (current) return current;

  let legacy: any;
  try {
    legacy = await db.get(LEGACY_CHECKPOINT_ID);
  } catch {
    return null; // nothing to adopt — a fresh instance starts at `now`
  }
  // Only our own doc. Anything else at that id is somebody else's, and deleting a
  // document we can't account for is not a repair.
  if (legacy?.type !== CHECKPOINT_TYPE) return null;

  const seq = typeof legacy.seq === "string" ? legacy.seq : null;
  if (seq) await writeCheckpoint(db, seq);
  try {
    await db.destroy(LEGACY_CHECKPOINT_ID, legacy._rev);
  } catch {
    // Still spinning until the next boot retries, but the position is already saved.
  }
  return seq;
}

/**
 * Store the resume point. Mutable operational state, like the migration marker —
 * not session history, so it doesn't break the append-only rule for session docs.
 *
 * No read-before-write: a `_local/` doc has no revision tree (CouchDB answers every
 * write with `0-1`), so an overwrite needs no `_rev` and this costs one round trip
 * per batch instead of two.
 */
export async function writeCheckpoint(db: CheckpointStore, seq: string): Promise<void> {
  try {
    await db.insert(
      {
        _id: CHECKPOINT_ID,
        type: CHECKPOINT_TYPE,
        seq,
        updated_at: new Date().toISOString(),
      },
      CHECKPOINT_ID,
    );
  } catch {
    // A lost checkpoint only costs us a replay, never correctness.
  }
}

/**
 * How long changes wait before reaching Meilisearch. Each flush is one update per
 * index however many docs it carries, and Meilisearch's disk cost is per update (#231)
 * — but a flush now writes only the small indexes (sessions, live turns), so it can
 * run often. Overridable via `system.search.flushIntervalMs`.
 */
export const DEFAULT_SEARCH_FLUSH_INTERVAL_MS = 20 * 1000;

/**
 * How often ended sessions are promoted from the live turns index into the archive.
 * Every promotion is one update to the large index, so they are batched on this much
 * slower clock. Ended sessions stay searchable in the live index until then.
 * Overridable via `system.search.archiveIntervalMs`.
 */
export const DEFAULT_ARCHIVE_INTERVAL_MS = 15 * 60 * 1000;

/**
 * How often the live turns index is rebuilt from CouchDB, as a backstop against rows a
 * failed flush dropped. It is small, so this is cheap. Runs as part of a maintenance
 * pass, so it happens at most that often. Overridable via
 * `system.search.liveRebuildIntervalMs`.
 */
export const DEFAULT_LIVE_REBUILD_INTERVAL_MS = 60 * 60 * 1000;

/** Flush early past this many buffered rows, so a bulk write can't pile up unbounded. */
const MAX_BUFFERED_ROWS = 2000;

/** Sessions per promotion request, so one filter or payload stays a sane size. */
const PROMOTE_BATCH = 100;

/**
 * Finished Meilisearch tasks older than this are pruned, at most once per this period.
 * Overridable via `system.search.taskRetentionMs`.
 */
export const DEFAULT_TASK_RETENTION_MS = 60 * 60 * 1000;

/** A summary the hook wrote at session end — undefined `source` is live (see `toSessionSearchDoc`). */
export function isLiveSessionEnd(doc: any): boolean {
  return doc?.type === "summary" && (doc.source ?? "live") === "live";
}

/**
 * Buffer a batch of changed docs for search. Only called when search is on.
 *
 * Split out of the batch handler so that handler reads as the two things it does —
 * patch the session index, then queue the search work — rather than as one long block
 * in which the search half hides the other.
 */
export function bufferForSearch(buffer: SearchBuffer, docs: any[]): void {
  for (const d of docs) {
    if (d.type === "summary") buffer.addSummary(String(d.session_id), toSessionSearchDoc(d));
    else if (d.type === "chunk") buffer.addTurns(toTurnSearchDocs(d));
  }
  // A session becomes findable as soon as it starts, not when it ends. Event docs
  // name the sessions that moved; the ones still without a summary are projected from
  // the aggregate at flush time, which is the only place a running session's rollup
  // exists. See `flushSearch`.
  for (const d of docs) if (d.type === "event" && d.session_id) buffer.touch(String(d.session_id));
}

/**
 * Write one buffered batch to Meilisearch: at most one update to the sessions index
 * and one to the live turns index. Never the archive — sessions that belong there are
 * added to `promote` instead, for the next maintenance pass.
 *
 * Running sessions are projected here rather than when their events arrived, so a
 * session that moved forty times since the last flush costs one row, built from its
 * rollup as it stands now.
 *
 * Projecting from the event doc itself would be cheaper and wrong: Meilisearch's
 * add-or-replace would let a sparse event-shaped row overwrite the complete
 * record an ended session already has.
 */
async function flushSearch(
  ctx: AppContext,
  db: any,
  batch: SearchBatch,
  promote: Set<string>,
): Promise<void> {
  const turnSessions = new Set<string>();
  for (const row of batch.turns.values()) turnSessions.add(String(row.sessionId));
  // The session index is patched from every batch as it arrives, so when it is warm
  // the rollups are already in memory and this costs no round trip at all.
  const aggs = await sessionAggregates(ctx, db, [...new Set([...batch.running, ...turnSessions])]);

  const sessionDocs = [...batch.summaries.values()];
  for (const id of batch.running) {
    const agg = aggs.get(id);
    // A summary flushed in an earlier batch shows up here as `agg.summary`.
    if (!agg || agg.summary) continue;
    sessionDocs.push(toRunningSessionSearchDoc(id, agg));
  }

  // An ended session's turns go to the archive, which promotion reads from CouchDB —
  // so they are not written anywhere here. That also keeps a backfill, which writes
  // thousands of ended sessions at once, out of the live index entirely.
  const isLive = liveClassifier(ctx, aggs);
  const liveTurns: Record<string, unknown>[] = [];
  for (const row of batch.turns.values()) {
    const id = String(row.sessionId);
    if (!batch.summaries.has(id) && isLive(id)) liveTurns.push(row);
    else promote.add(id);
  }
  for (const id of batch.summaries.keys()) promote.add(id);

  if (sessionDocs.length)
    await ctx.meili.index(indexName(ctx.config, SESSIONS_INDEX_KEY), sessionDocs);
  if (liveTurns.length)
    await ctx.meili.index(indexName(ctx.config, LIVE_TURNS_INDEX_KEY), liveTurns);
}

/**
 * Move these sessions' turns from the live index into the archive: add them to the
 * archive from CouchDB, wait until Meilisearch confirms, then delete them from live.
 *
 * In that order on purpose. The other way round leaves a window in which the session
 * can't be found at all; this way the worst case is a moment in both indexes, which
 * search de-duplicates by turn id. A batch the archive rejects stays where it is and
 * is retried next pass. Returns the sessions that could not be promoted.
 */
async function promoteSessions(ctx: AppContext, db: any, ids: string[]): Promise<string[]> {
  const archive = indexName(ctx.config, TURNS_INDEX_KEY);
  const live = indexName(ctx.config, LIVE_TURNS_INDEX_KEY);
  const failed: string[] = [];
  for (let i = 0; i < ids.length; i += PROMOTE_BATCH) {
    const group = ids.slice(i, i + PROMOTE_BATCH);
    try {
      const turns = await loadSessionTurns(db, group);
      const tasks: number[] = [];
      for (let j = 0; j < turns.length; j += INDEX_BATCH) {
        const task = await ctx.meili.index(archive, turns.slice(j, j + INDEX_BATCH));
        if (task === null) throw new Error("Meilisearch did not accept the archive batch");
        tasks.push(task);
      }
      const { failures } = await ctx.meili.taskFailures(tasks);
      if (failures.length) throw new Error(failures.join("; "));
      await ctx.meili.deleteDocs(live, { filter: sessionFilter(group) });
    } catch (err) {
      console.error(`[changes] promoting ${group.length} session(s) failed (will retry):`, err);
      failed.push(...group);
    }
  }
  return failed;
}

/**
 * Start following the feed.
 *
 * The first run starts at `now` rather than replaying all of history: an existing
 * corpus is bulk-loaded far more cheaply by `reindex` (search) and a single grouped
 * query (the session index) than by streaming every past change through them.
 */
export interface SearchFlusher {
  buffer: SearchBuffer;
  /** Index what is buffered, then checkpoint. Resolves once both are done. */
  flush(): Promise<void>;
  /**
   * The slow pass: promote ended sessions into the archive and, when due, rebuild the
   * live index. Queued with flushes, never alongside one.
   */
  maintain(): Promise<void>;
}

/** Every index name this deployment owns, side indexes included — for task pruning. */
function ownedIndexes(ctx: AppContext): string[] {
  return [SESSIONS_INDEX_KEY, TURNS_INDEX_KEY, LIVE_TURNS_INDEX_KEY]
    .map((key) => indexName(ctx.config, key))
    .flatMap((uid) => [uid, rebuildIndexName(uid)]);
}

/**
 * The buffer and the work that drains it, split out of the follower so the ordering
 * it promises — index, then checkpoint; one Meilisearch job at a time, in the order
 * asked — can be tested without a change feed.
 *
 * Everything goes through one queue. A live rebuild that overlapped a flush could swap
 * out an index the flush had just written to, and a promotion that overlapped one
 * could delete live turns the flush had just added; serialising them makes both
 * impossible rather than unlikely.
 */
export function createSearchFlusher(
  ctx: AppContext,
  db: any,
  taskRetentionMs = ctx.config.system.search?.taskRetentionMs ?? DEFAULT_TASK_RETENTION_MS,
): SearchFlusher {
  const buffer = new SearchBuffer();
  const liveRebuildMs =
    ctx.config.system.search?.liveRebuildIntervalMs ?? DEFAULT_LIVE_REBUILD_INTERVAL_MS;
  /** Sessions whose turns belong in the archive and haven't been moved yet. */
  const promote = new Set<string>();
  let queue: Promise<void> | null = null;
  // Zero, so the first pass after boot prunes and rebuilds: that clears whatever queue
  // built up before this instance started, and whatever the live index drifted into.
  let lastPrune = 0;
  let lastLiveRebuild = 0;

  /**
   * Run `job` once everything queued before it is done. On an idle queue it starts
   * synchronously, so a flush takes its batch the moment it is asked for — the docs
   * the caller just buffered — rather than a tick later.
   */
  const enqueue = (job: () => Promise<void>): Promise<void> => {
    const run = queue ? queue.then(job) : job();
    const tail = run.catch(() => {});
    queue = tail;
    void tail.then(() => {
      if (queue === tail) queue = null;
    });
    return run;
  };

  /**
   * The checkpoint waits for the flush on purpose: advancing it per batch while the
   * docs sat in memory would let a crash or restart skip everything buffered at the
   * time. A flush asked for while one is running queues behind it rather than joining
   * it: the running one took its batch before the caller's docs arrived, so joining
   * would leave them for the next interval.
   *
   * The checkpoint does *not* wait for promotion: an ended session left in the live
   * index by a restart is still searchable, and the next maintenance pass finds it.
   */
  const flush = (): Promise<void> =>
    enqueue(async () => {
      const batch = buffer.take();
      try {
        await flushSearch(ctx, db, batch, promote);
      } catch (err) {
        // The rows are dropped, not retried, and the checkpoint still advances past
        // them: the live rebuild and `POST /api/search/reindex` are the
        // reconciliation paths, as they were when a per-batch index failed.
        console.error("[changes] flushing search updates failed (continuing):", err);
      }
      if (batch.seq) await writeCheckpoint(db, batch.seq);
      if (Date.now() - lastPrune >= taskRetentionMs) {
        lastPrune = Date.now();
        await ctx.meili.pruneTasks(ownedIndexes(ctx), taskRetentionMs);
      }
    });

  const maintain = (): Promise<void> =>
    enqueue(async () => {
      try {
        // Which sessions does the live index hold that no longer belong there? This
        // is what recovers promotions lost to a restart, and it settles sessions that
        // went quiet without ending.
        const liveUid = indexName(ctx.config, LIVE_TURNS_INDEX_KEY);
        const held = (await ctx.meili.facets(liveUid, ["sessionId"])).sessionId ?? [];
        const heldAggs = await sessionAggregates(ctx, db, held);
        const heldLive = liveClassifier(ctx, heldAggs);
        for (const id of held) if (!heldLive(id)) promote.add(id);

        const ids = [...promote];
        promote.clear();
        const failed = await promoteSessions(ctx, db, ids);
        for (const id of failed) promote.add(id);

        // The rebuild needs the full session list, which only a warm index has.
        if (ctx.sessionIndex.ready && Date.now() - lastLiveRebuild >= liveRebuildMs) {
          lastLiveRebuild = Date.now();
          const all = new Map(ctx.sessionIndex.rows().map((r) => [r.key, r.value] as const));
          const isLive = liveClassifier(ctx, all);
          // Sessions still waiting on promotion stay in the live index until it lands.
          const keep = [...all.keys()].filter((id) => isLive(id) || promote.has(id));
          const turns = await loadSessionTurns(db, keep);
          const { failures } = await rebuildIndex(
            ctx.meili,
            liveUid,
            LIVE_TURNS_INDEX_SETTINGS,
            turns,
          );
          if (failures.length)
            console.error("[changes] rebuilding the live turns index failed:", failures);
        }
      } catch (err) {
        console.error("[changes] search maintenance failed (continuing):", err);
      }
    });

  return { buffer, flush, maintain };
}

export function startChangesFollower(ctx: AppContext): ChangesFollower {
  const db = ctx.couch.db("sessions") as any;
  const flushIntervalMs =
    ctx.config.system.search?.flushIntervalMs ?? DEFAULT_SEARCH_FLUSH_INTERVAL_MS;
  const archiveIntervalMs =
    ctx.config.system.search?.archiveIntervalMs ?? DEFAULT_ARCHIVE_INTERVAL_MS;
  const { buffer, flush, maintain } = createSearchFlusher(ctx, db);
  let stopped = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  let maintenance: ReturnType<typeof setInterval> | undefined;
  // The follower keeps the session index current, which is what tells it which
  // sessions went quiet without ending — so it is also what finalises them.
  const reconcile = startReconcileSweep(ctx);

  void (async () => {
    const since = (await readCheckpoint(db)) ?? "now";
    if (stopped) return;

    if (ctx.meili.enabled) {
      timer = setInterval(() => void flush(), flushIntervalMs);
      maintenance = setInterval(() => void maintain(), archiveIntervalMs);
      // Never the thing holding the process open.
      timer.unref?.();
      maintenance.unref?.();
    }

    // `wait: true` holds the next request until we've handled the current batch, so a
    // burst of writes can't outrun the indexer or balloon memory.
    const feed = db.changesReader.start({
      since,
      includeDocs: true,
      batchSize: 100,
      wait: true,
    });

    feed.on("batch", async (batch: any[]) => {
      try {
        const docs = batch.map((c) => c?.doc).filter((d) => d && !d._deleted);

        // Every doc type the aggregate maps over — `event`, `summary` and `chunk` —
        // changes the answer for its session, so all three are re-read. The session
        // index stays per batch: it is in memory, and the list should be live.
        await ctx.sessionIndex.refresh([
          ...new Set(docs.filter((d) => d.session_id).map((d) => String(d.session_id))),
        ]);

        const last = batch[batch.length - 1];
        if (ctx.meili.enabled) {
          bufferForSearch(buffer, docs);
          if (last?.seq) buffer.advance(String(last.seq));
          // A live session just ended: that's when someone goes looking for it, so it
          // doesn't wait out the interval. Live only — a backfill writes a summary per
          // session, and flushing on each would bring back one update per doc.
          // Awaited, so `wait` mode turns a burst into backpressure rather than memory.
          if (buffer.size >= MAX_BUFFERED_ROWS || docs.some(isLiveSessionEnd)) await flush();
        } else if (last?.seq) {
          await writeCheckpoint(db, String(last.seq));
        }
      } catch (err) {
        // Never let a batch failure stop the feed — the periodic index reload and
        // `POST /api/search/reindex` are the reconciliation paths.
        console.error("[changes] handling a change batch failed (continuing):", err);
      } finally {
        // In `wait` mode nano pauses the feed *before* emitting the batch and waits
        // for an explicit resume — there's no done-callback on the event. Miss this
        // and the feed delivers exactly one batch and then stalls forever.
        db.changesReader.resume();
      }
    });

    feed.on("error", (err: unknown) => {
      // nano retries transient errors itself; anything surfacing here is worth seeing.
      console.error("[changes] feed error:", err);
    });
  })();

  return {
    async stop() {
      stopped = true;
      if (timer) clearInterval(timer);
      if (maintenance) clearInterval(maintenance);
      reconcile?.stop();
      try {
        db.changesReader.stop();
      } catch {
        // already stopped
      }
      // Whatever was buffered goes out now rather than waiting on a restart's replay.
      // Awaited, so a caller shutting down can hold the exit until it has landed.
      if (ctx.meili.enabled) await flush();
    },
  };
}

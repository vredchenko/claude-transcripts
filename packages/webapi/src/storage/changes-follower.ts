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
 * Scope, deliberately: **upserts only**. Docs here are append-only by invariant
 * ([ADR 0016]), so deletion is an out-of-band admin action; `POST /api/search/reindex`
 * stays the reconciliation step for deletes and for history written before search
 * existed. Everything is best-effort — a failure here must never take down the webapi.
 */

import { indexName } from "../config";
import type { AppContext } from "../context";
import {
  SESSIONS_INDEX_KEY,
  TURNS_INDEX_KEY,
  toRunningSessionSearchDoc,
  toSessionSearchDoc,
  toTurnSearchDocs,
} from "./meili";

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
  stop(): void;
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
 * Project a batch of changed docs into Meilisearch. Only called when search is on.
 *
 * Split out of the batch handler so that handler reads as the two things it does —
 * patch the session index, then index for search — rather than as one long block in
 * which the search half hides the other.
 */
async function indexForSearch(ctx: AppContext, db: any, docs: any[]): Promise<void> {
  const sessionDocs = docs.filter((d) => d.type === "summary").map((d) => toSessionSearchDoc(d));
  const turnDocs = docs.filter((d) => d.type === "chunk").flatMap((d) => toTurnSearchDocs(d));

  // A session becomes findable as soon as it starts, not when it ends. Event docs
  // name the sessions that moved; re-project the ones still without a summary from
  // the aggregate, which is the only place a running session's rollup exists.
  //
  // Projecting from the event doc itself would be cheaper and wrong: Meilisearch's
  // add-or-replace would let a sparse event-shaped row overwrite the complete
  // record an ended session already has.
  const touched = new Set(
    docs.filter((d) => d.type === "event" && d.session_id).map((d) => String(d.session_id)),
  );
  const alreadyEnded = new Set(docs.filter((d) => d.type === "summary").map((d) => d.session_id));
  const pending = [...touched].filter((id) => !alreadyEnded.has(id));
  if (pending.length) {
    // The session index was patched from this same batch a moment ago, so when it is
    // warm the rollups are already in memory and this costs no round trip at all.
    const rows = ctx.sessionIndex.ready
      ? pending.map((key) => ({ key, value: ctx.sessionIndex.get(key) }))
      : (
          await db.view("session_index", "aggregate", {
            group: true,
            reduce: true,
            keys: pending,
          })
        ).rows;
    for (const row of rows as any[]) {
      if (!row?.value || row.value.summary) continue;
      sessionDocs.push(toRunningSessionSearchDoc(String(row.key), row.value));
    }
  }

  if (sessionDocs.length)
    await ctx.meili.index(indexName(ctx.config, SESSIONS_INDEX_KEY), sessionDocs);
  if (turnDocs.length) await ctx.meili.index(indexName(ctx.config, TURNS_INDEX_KEY), turnDocs);
}

/**
 * Start following the feed.
 *
 * The first run starts at `now` rather than replaying all of history: an existing
 * corpus is bulk-loaded far more cheaply by `reindex` (search) and a single grouped
 * query (the session index) than by streaming every past change through them.
 */
export function startChangesFollower(ctx: AppContext): ChangesFollower {
  const db = ctx.couch.db("sessions") as any;
  let stopped = false;

  void (async () => {
    const since = (await readCheckpoint(db)) ?? "now";
    if (stopped) return;

    // `wait: true` holds the next request until we've indexed the current batch, so a
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
        // changes the answer for its session, so all three are re-read. This runs
        // first so the search projection below sees the fresh rollups.
        await ctx.sessionIndex.refresh([
          ...new Set(docs.filter((d) => d.session_id).map((d) => String(d.session_id))),
        ]);

        if (ctx.meili.enabled) await indexForSearch(ctx, db, docs);

        const last = batch[batch.length - 1];
        if (last?.seq) await writeCheckpoint(db, String(last.seq));
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
    stop() {
      stopped = true;
      try {
        db.changesReader.stop();
      } catch {
        // already stopped
      }
    },
  };
}

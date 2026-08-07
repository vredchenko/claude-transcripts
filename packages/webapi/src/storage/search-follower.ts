/**
 * Keeps the Meilisearch indexes current by following CouchDB's `_changes` feed.
 *
 * Indexing used to happen only as a side effect of `/api/ingest/*`, which left a hole:
 * the hook writes straight to CouchDB, so a live-recorded session was never searchable
 * until someone ran a manual reindex. Following the change feed closes that without
 * coupling the writer to the reader — whoever writes a doc, by whatever path, the
 * index catches up. It also keeps the hook free of a hard dependency on the webapi
 * being up, which matters because the hook must never block a session.
 *
 * Scope, deliberately: **upserts only**. Docs here are append-only by invariant
 * ([ADR 0016]), so deletion is an out-of-band admin action; `POST /api/search/reindex`
 * stays the reconciliation step for deletes and for history written before search
 * existed. Everything is best-effort — a failure here must never take down the webapi.
 */
import type { AppContext } from "../context";
import {
  SESSIONS_INDEX,
  TURNS_INDEX,
  toRunningSessionSearchDoc,
  toSessionSearchDoc,
  toTurnSearchDocs,
} from "./meili";

/** Doc id of the resume point, so a restart doesn't replay the whole feed. */
const CHECKPOINT_ID = "search_checkpoint";

export interface SearchFollower {
  stop(): void;
}

/** Read the stored `_changes` sequence, or null when we've never followed before. */
async function readCheckpoint(db: any): Promise<string | null> {
  try {
    const doc = await db.get(CHECKPOINT_ID);
    return typeof doc?.seq === "string" ? doc.seq : null;
  } catch {
    return null; // no checkpoint yet
  }
}

/**
 * Store the resume point. Mutable operational state, like the migration marker —
 * not session history, so it doesn't break the append-only rule for session docs.
 */
async function writeCheckpoint(db: any, seq: string): Promise<void> {
  try {
    let rev: string | undefined;
    try {
      rev = (await db.get(CHECKPOINT_ID))?._rev;
    } catch {
      // first write
    }
    await db.insert({
      _id: CHECKPOINT_ID,
      ...(rev ? { _rev: rev } : {}),
      type: "search_checkpoint",
      seq,
      updated_at: new Date().toISOString(),
    });
  } catch {
    // A lost checkpoint only costs us a replay, never correctness.
  }
}

/**
 * Start following the feed. Returns null when search is off, so the caller can log it.
 *
 * The first run starts at `now` rather than replaying all of history: an existing
 * corpus is bulk-loaded far more cheaply by `reindex` than by streaming every past
 * change through the indexer.
 */
export function startSearchFollower(ctx: AppContext): SearchFollower | null {
  if (!ctx.meili.enabled) return null;

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
        const sessionDocs = docs
          .filter((d) => d.type === "summary")
          .map((d) => toSessionSearchDoc(d));
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
        const alreadyEnded = new Set(
          docs.filter((d) => d.type === "summary").map((d) => d.session_id),
        );
        const pending = [...touched].filter((id) => !alreadyEnded.has(id));
        if (pending.length) {
          const agg = await db.view("session_index", "aggregate", {
            group: true,
            reduce: true,
            keys: pending,
          });
          for (const row of agg.rows as any[]) {
            if (!row?.value || row.value.summary) continue;
            sessionDocs.push(toRunningSessionSearchDoc(String(row.key), row.value));
          }
        }

        if (sessionDocs.length) await ctx.meili.index(SESSIONS_INDEX, sessionDocs);
        if (turnDocs.length) await ctx.meili.index(TURNS_INDEX, turnDocs);

        const last = batch[batch.length - 1];
        if (last?.seq) await writeCheckpoint(db, String(last.seq));
      } catch (err) {
        // Never let an indexing failure stop the feed — the next reindex reconciles.
        console.error("[search] indexing a change batch failed (continuing):", err);
      } finally {
        // In `wait` mode nano pauses the feed *before* emitting the batch and waits
        // for an explicit resume — there's no done-callback on the event. Miss this
        // and the feed delivers exactly one batch and then stalls forever.
        db.changesReader.resume();
      }
    });

    feed.on("error", (err: unknown) => {
      // nano retries transient errors itself; anything surfacing here is worth seeing.
      console.error("[search] changes feed error:", err);
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

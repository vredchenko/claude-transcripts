/**
 * Which turns index a session's turns belong in, and the two ways turns move: a
 * session's promotion from live to archive, and a whole-index rebuild (ADR 0032).
 *
 * A session's turns are **live** while it is `running` — no summary yet, and active
 * within the live window — and **archived** once it ends, or once it has gone quiet for
 * longer than the window without ending. The second clause is what keeps the live index
 * small on a deployment with the reconcile sweep switched off: a crashed session would
 * otherwise sit in it for good. A session that went quiet and then resumes is live
 * again; one resumed after its summary was written stays archived, and its new turns
 * join the archive on the next pass. Turn ids are stable, so moving a session twice
 * replaces rather than duplicates.
 */
import type { SessionAggregate } from "@claude-transcripts/shared";
import { liveWindowMs } from "../config";
import type { AppContext } from "../context";
import { sessionStatus } from "../routes/sessions";
import { type IndexSettings, type Meili, toTurnSearchDocs } from "./meili";

/** Documents per Meilisearch request — keeps a big rebuild off one huge payload. */
export const INDEX_BATCH = 1000;

/** Sessions per CouchDB lookup. */
const KEYS_BATCH = 100;

/**
 * Do this session's turns belong in the live index? An unknown session counts as live:
 * the maintenance pass re-checks every session the live index holds, so a wrong guess
 * here costs a short stay, where guessing "archived" for a running session would send
 * every one of its turns through the expensive index.
 */
export function belongsLive(
  agg: SessionAggregate | undefined,
  nowMs: number,
  windowMs: number,
): boolean {
  return !agg || sessionStatus(agg, nowMs, windowMs) === "running";
}

/** A predicate over session ids, for the current config and clock. */
export function liveClassifier(
  ctx: AppContext,
  aggs: Map<string, SessionAggregate | undefined>,
): (sessionId: string) => boolean {
  const now = Date.now();
  const window = liveWindowMs(ctx.config);
  return (id) => belongsLive(aggs.get(id), now, window);
}

/**
 * These sessions' rollups: from the in-memory session index when it is warm (no round
 * trip), else from the aggregate view directly.
 */
export async function sessionAggregates(
  ctx: AppContext,
  db: any,
  ids: string[],
): Promise<Map<string, SessionAggregate | undefined>> {
  const out = new Map<string, SessionAggregate | undefined>();
  if (!ids.length) return out;
  if (ctx.sessionIndex.ready) {
    for (const id of ids) out.set(id, ctx.sessionIndex.get(id));
    return out;
  }
  for (let i = 0; i < ids.length; i += KEYS_BATCH) {
    const res = await db.view("session_index", "aggregate", {
      group: true,
      reduce: true,
      keys: ids.slice(i, i + KEYS_BATCH),
    });
    for (const row of res.rows as any[]) {
      if (row?.value) out.set(String(row.key), row.value);
    }
  }
  return out;
}

/**
 * Every turn row of these sessions, projected from their full-content chunks in
 * CouchDB. The store, not the live index, is the source: the live index may be missing
 * rows from a failed flush, and promotion is the moment to put that right.
 */
export async function loadSessionTurns(db: any, ids: string[]): Promise<Record<string, unknown>[]> {
  const out: Record<string, unknown>[] = [];
  for (const id of ids) {
    const res = await db.view("chunks", "by_session", {
      startkey: [id],
      endkey: [id, {}],
      include_docs: true,
    });
    for (const row of res.rows as any[]) {
      if (row?.doc?.type === "chunk") out.push(...toTurnSearchDocs(row.doc));
    }
  }
  return out;
}

/** A Meilisearch filter matching any of these sessions. */
export function sessionFilter(ids: string[]): string {
  return `sessionId IN [${ids.map((id) => JSON.stringify(id)).join(", ")}]`;
}

/** The side index a rebuild of `uid` fills before swapping in. */
export function rebuildIndexName(uid: string): string {
  return `${uid}-rebuild`;
}

/**
 * Rebuild an index from `docs` without emptying it in the meantime.
 *
 * The docs go into a side index; only once Meilisearch has accepted every batch does it
 * swap places with the real one, and the side index (now holding the old contents) is
 * dropped. A rebuild that fails leaves the index as it was and reports why. Clearing in
 * place, as reindex used to, made search return nothing until the refill landed — fine
 * for a one-off repair, not for something that runs on a schedule.
 */
export async function rebuildIndex(
  meili: Meili,
  uid: string,
  settings: IndexSettings,
  docs: Record<string, unknown>[],
): Promise<{ indexed: number; failures: string[] }> {
  const side = rebuildIndexName(uid);
  // A side index left by an interrupted rebuild would merge its rows into this one.
  const dropped = await meili.deleteIndex(side);
  if (dropped !== null) await meili.taskFailures([dropped]);
  await meili.ensureIndex(side, settings);
  await meili.ensureIndex(uid, settings);

  const tasks: number[] = [];
  for (let i = 0; i < docs.length; i += INDEX_BATCH) {
    const task = await meili.index(side, docs.slice(i, i + INDEX_BATCH));
    if (task !== null) tasks.push(task);
  }
  const filled = await meili.taskFailures(tasks);
  if (filled.failures.length) {
    await meili.deleteIndex(side);
    return filled;
  }

  const swap = await meili.swapIndexes(uid, side);
  if (swap === null) {
    await meili.deleteIndex(side);
    return { indexed: 0, failures: [`could not swap ${side} into ${uid}`] };
  }
  const swapped = await meili.taskFailures([swap]);
  await meili.deleteIndex(side);
  return { indexed: filled.indexed, failures: swapped.failures };
}

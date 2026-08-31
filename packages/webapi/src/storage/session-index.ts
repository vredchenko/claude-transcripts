/**
 * An in-memory index of every session's aggregate, kept current from CouchDB's
 * `_changes` feed.
 *
 * `session_index/aggregate` reduces in JavaScript, and CouchDB can only re-use the
 * reduction values stored in its btree nodes when a node's whole span falls inside
 * one group. Grouped per session it never does, so every `group=true` query re-feeds
 * essentially the whole corpus back through the `couchjs` query server: ~20 ms per
 * session, measured, growing with every session recorded. On a real instance (463
 * sessions, 49 k docs) that made the session list an **8-second** request — the
 * whole of the webui's landing-page wait (#107).
 *
 * The fix is to stop asking the question repeatedly. The answer for a given session
 * changes only when that session gets new documents, and the change feed says exactly
 * which ones those are — so the full query runs once at boot and thereafter only the
 * sessions a change batch touched are re-read (`keys=[…]`, ~20 ms each). The list
 * route then filters, sorts and paginates in memory, which is what it already did
 * with the view's rows.
 *
 * Three properties this deliberately keeps:
 *
 * - **It is a cache, not a source of truth.** Rows are stored exactly as the view
 *   returns them; every judgement about what a row *means* (what counts as a real
 *   session, how it projects to a summary) stays in the route. A reader that must be
 *   authoritative — the search reindex — still queries CouchDB.
 * - **It fails soft.** Until the first load finishes, and after any load that fails,
 *   `ready` is false and callers fall back to querying the view. A cold or broken
 *   index costs latency, never correctness.
 * - **It self-heals.** A change feed that dies would otherwise leave a silently stale
 *   list, so the caller reloads periodically as a backstop, and `status()` is
 *   reported by `/health` so staleness is visible rather than inferred.
 */
import type { SessionAggregate } from "@claude-transcripts/shared";

/**
 * How many sessions to re-read in one view request. Matches the batch used for
 * active durations: it bounds request and response size, not the number of trips.
 */
const BATCH = 100;

/** The slice of a CouchDB database handle this module uses — see the tests' fake. */
export interface AggregateView {
  view(
    design: string,
    name: string,
    params: Record<string, unknown>,
  ): Promise<{ rows: { key?: unknown; value?: unknown }[] }>;
}

/** One session's row, in the shape the view returns it. */
export interface SessionIndexRow {
  key: string;
  value: SessionAggregate;
}

/** What `/health` reports, so a stale or broken index is visible. */
export interface SessionIndexStatus {
  /** Is there a complete set of rows to read? False while cold, or after a failed load. */
  ready: boolean;
  /** How many sessions are held. */
  sessions: number;
  /** When the last full load completed. */
  loadedAt?: string;
  /** When a change batch last patched a session in. */
  updatedAt?: string;
  /** Why the last load failed, when it did. */
  error?: string;
}

export interface SessionIndex {
  /** Every session's row. Empty when not ready — check {@link SessionIndex.ready} first. */
  rows(): SessionIndexRow[];
  /** One session's aggregate, or undefined when this index has never seen it. */
  get(sessionId: string): SessionAggregate | undefined;
  /** True once a full load has succeeded. */
  readonly ready: boolean;
  /** (Re)read every session. Idempotent, and never runs twice concurrently. */
  load(): Promise<void>;
  /** Re-read just these sessions and patch them in. No-op when not ready. */
  refresh(sessionIds: string[]): Promise<void>;
  status(): SessionIndexStatus;
}

/** A row is usable only if the view gave us an object to store. */
function aggregateOf(row: { key?: unknown; value?: unknown }): SessionAggregate | null {
  const value = row?.value;
  return value !== null && typeof value === "object" ? (value as SessionAggregate) : null;
}

export function createSessionIndex(db: AggregateView): SessionIndex {
  const sessions = new Map<string, SessionAggregate>();
  let ready = false;
  let loadedAt: string | undefined;
  let updatedAt: string | undefined;
  let error: string | undefined;
  /** In-flight load, so a periodic reload can't stack on a slow one. */
  let loading: Promise<void> | null = null;

  async function readAll(): Promise<void> {
    const res = await db.view("session_index", "aggregate", { group: true, reduce: true });
    // Build beside the live map and swap: a load that throws half way through must
    // leave the previous answer intact rather than a partial one.
    const next = new Map<string, SessionAggregate>();
    for (const row of res.rows ?? []) {
      const value = aggregateOf(row);
      if (value) next.set(String(row.key), value);
    }
    sessions.clear();
    for (const [id, value] of next) sessions.set(id, value);
    ready = true;
    loadedAt = new Date().toISOString();
    error = undefined;
  }

  return {
    rows() {
      return [...sessions].map(([key, value]) => ({ key, value }));
    },

    get(sessionId) {
      return sessions.get(sessionId);
    },

    get ready() {
      return ready;
    },

    load() {
      if (loading) return loading;
      loading = readAll()
        .catch((err: unknown) => {
          // Leave `ready` as it was: a failed *re*load keeps serving the last good
          // answer, and a failed first load keeps callers on the direct query.
          error = err instanceof Error ? err.message : String(err);
          console.error("[session-index] load failed (callers fall back to CouchDB):", err);
        })
        .finally(() => {
          loading = null;
        });
      return loading;
    },

    async refresh(sessionIds) {
      // Nothing to patch into: the pending full load will pick these up anyway.
      if (!ready || sessionIds.length === 0) return;
      const unique = [...new Set(sessionIds)];
      for (let i = 0; i < unique.length; i += BATCH) {
        const keys = unique.slice(i, i + BATCH);
        try {
          const res = await db.view("session_index", "aggregate", {
            group: true,
            reduce: true,
            keys,
          });
          for (const row of res.rows ?? []) {
            const value = aggregateOf(row);
            if (value) sessions.set(String(row.key), value);
          }
        } catch (err) {
          // A missed patch is staleness for one session until the next periodic
          // reload — never a reason to stop following the feed.
          console.error("[session-index] refresh failed (will reconcile on reload):", err);
          return;
        }
      }
      updatedAt = new Date().toISOString();
    },

    status() {
      return {
        ready,
        sessions: sessions.size,
        ...(loadedAt ? { loadedAt } : {}),
        ...(updatedAt ? { updatedAt } : {}),
        ...(error ? { error } : {}),
      };
    },
  };
}

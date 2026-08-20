/**
 * Active (working) duration per session: the wall-clock span minus idle gaps.
 *
 * A session's runtime is the distance from its first event to its last, which counts
 * the hours it sat open in a tmux pane doing nothing. Active time is the same span with
 * every gap longer than `system.sessions.idleThresholdMs` removed, so "ran for four
 * days" and "worked for two hours" stop being the same number. Both are shown together
 * everywhere — either alone invites the wrong reading.
 *
 * Computing it needs **every** event's timestamp rather than the first and last, which
 * is why this reads `session_index/event_times` (migration v9): one row per doc valued
 * with nothing but its timestamp, so a whole page of the session list costs one request
 * instead of one per row. The `aggregate` view can answer the same question with
 * `reduce=false`, but its value is the entire per-session rollup — affordable for the
 * one session on a detail page, not for fifty.
 */
import { sumActiveDurationMs } from "@claude-transcripts/shared";

/**
 * How many sessions to ask for in one view request. A list page is 50 and a calendar
 * month asks for up to 500, so this bounds the request and response size rather than
 * the number of round-trips.
 */
const BATCH = 100;

/** Default size of the memo. Comfortably more than a reader pages through in a sitting. */
const CACHE_LIMIT = 4000;

/** The slice of a CouchDB database handle this module uses. */
export interface TimestampView {
  view(
    design: string,
    name: string,
    params: { keys: string[] },
  ): Promise<{ rows: { key?: unknown; value?: unknown }[] }>;
}

/** A session whose active duration is wanted, and how far its history reaches. */
export interface ActiveQuery {
  sessionId: string;
  /**
   * The newest timestamp known for the session — the memo's invalidation handle. Docs
   * are append-only, so an ended session's answer is final; a live one keys off a
   * `lastActivity` that moves, and so recomputes exactly when new events land.
   */
  through: string;
}

/**
 * A bounded memo of answers. Insertion-ordered, oldest evicted first, which suits a
 * corpus browsed newest-first. `null` records "not derivable", so a session with a
 * single event isn't re-queried on every page load.
 *
 * Created per app rather than per process: a module-level cache would leak between
 * tests and between two webapis in one process, and buys nothing.
 */
export interface ActiveDurationCache {
  get(key: string): number | null | undefined;
  set(key: string, value: number | null): void;
  readonly size: number;
}

export function createActiveDurationCache(limit = CACHE_LIMIT): ActiveDurationCache {
  const entries = new Map<string, number | null>();
  return {
    get: (key) => entries.get(key),
    set(key, value) {
      if (entries.size >= limit) {
        const oldest = entries.keys().next().value;
        if (oldest !== undefined) entries.delete(oldest);
      }
      entries.set(key, value);
    },
    get size() {
      return entries.size;
    },
  };
}

function cacheKey(query: ActiveQuery, idleMs: number): string {
  return `${query.sessionId}@${query.through}@${idleMs}`;
}

/**
 * Collect the timestamps a batch of `event_times` rows carries, per session.
 *
 * Tolerant of what a view can legitimately return — a row whose value isn't a string,
 * or a key for a session that wasn't asked about — because a CouchDB view is recomputed
 * over whatever documents exist, including ones written by an older hook.
 */
export function groupTimestamps(rows: { key?: unknown; value?: unknown }[]): Map<string, string[]> {
  const stamps = new Map<string, string[]>();
  for (const row of rows) {
    if (typeof row?.value !== "string" || row.value === "") continue;
    const id = String(row.key);
    const list = stamps.get(id);
    if (list) list.push(row.value);
    else stamps.set(id, [row.value]);
  }
  return stamps;
}

/**
 * Active duration in ms for each of `wanted` that has one.
 *
 * Degrades to what it already knows on any read failure: the view doesn't exist until
 * migration v9 has been applied, and a split that can't be computed must cost the
 * reader the *split*, not the list.
 */
export async function activeDurations(
  db: TimestampView,
  wanted: ActiveQuery[],
  idleMs: number,
  cache: ActiveDurationCache,
): Promise<Map<string, number>> {
  const found = new Map<string, number>();
  const pending: ActiveQuery[] = [];
  for (const query of wanted) {
    const cached = cache.get(cacheKey(query, idleMs));
    if (cached === undefined) pending.push(query);
    else if (cached !== null) found.set(query.sessionId, cached);
  }

  for (let i = 0; i < pending.length; i += BATCH) {
    const batch = pending.slice(i, i + BATCH);
    let rows: { key?: unknown; value?: unknown }[];
    try {
      const res = await db.view("session_index", "event_times", {
        keys: batch.map((query) => query.sessionId),
      });
      rows = res.rows ?? [];
    } catch {
      return found;
    }

    const stamps = groupTimestamps(rows);
    for (const query of batch) {
      const list = stamps.get(query.sessionId) ?? [];
      // One timestamp is a point, not a span: report nothing rather than zero, which
      // would read as "ran, and did nothing".
      const active = list.length < 2 ? null : sumActiveDurationMs(list, idleMs);
      cache.set(cacheKey(query, idleMs), active);
      if (active !== null) found.set(query.sessionId, active);
    }
  }
  return found;
}

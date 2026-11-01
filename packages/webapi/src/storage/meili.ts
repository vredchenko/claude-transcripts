/**
 * Minimal Meilisearch client (fetch-based, no SDK) for full-text session search
 * (ADR 0009). Search is **optional**: every call is best-effort and swallows errors,
 * so a down or absent Meilisearch never breaks ingest or the rest of the app. Gated
 * by `features.meilisearch` + `MEILI_HOST`; in the bundled dev stack Meili runs with
 * no master key, so `apiKey` is optional.
 */
import { HIGHLIGHT_POST, HIGHLIGHT_PRE } from "@claude-transcripts/shared";

export interface MeiliConfig {
  host: string;
  apiKey?: string;
  enabled: boolean;
}

export interface IndexSettings {
  primaryKey?: string;
  searchableAttributes?: string[];
  filterableAttributes?: string[];
  sortableAttributes?: string[];
  /**
   * How many distinct values a facet query returns. Meilisearch's default is 100; the
   * live turns index is faceted on `sessionId` to list the sessions it holds, so it
   * needs headroom past that.
   */
  maxValuesPerFacet?: number;
}

/** The task uid out of a Meilisearch `202 Accepted` body, or null. */
async function taskUidOf(res: Response | null): Promise<number | null> {
  if (!res?.ok) return null;
  try {
    const json = (await res.json()) as { taskUid?: number };
    return typeof json.taskUid === "number" ? json.taskUid : null;
  } catch {
    return null;
  }
}

/** Options shared by single-index and federated search queries. */
export interface QueryOptions {
  filter?: string[];
  attributesToCrop?: string[];
  cropLength?: number;
  attributesToHighlight?: string[];
}

/** The body fields a query's options become, minus paging. */
function queryBody(q: string, opts: QueryOptions): Record<string, unknown> {
  const body: Record<string, unknown> = { q };
  if (opts.filter?.length) body.filter = opts.filter;
  if (opts.attributesToCrop) body.attributesToCrop = opts.attributesToCrop;
  if (opts.cropLength) body.cropLength = opts.cropLength;
  if (opts.attributesToHighlight) {
    body.attributesToHighlight = opts.attributesToHighlight;
    // Private-use delimiters rather than Meilisearch's `<em>` default. A snippet is
    // rendered as *text* by every consumer, and transcripts contain arbitrary
    // markup — emitting HTML here would mean either escaping it back out or
    // rendering attacker-controlled tags. See `shared/src/highlight.ts`.
    body.highlightPreTag = HIGHLIGHT_PRE;
    body.highlightPostTag = HIGHLIGHT_POST;
  }
  return body;
}

export class Meili {
  private readonly cfg: MeiliConfig;

  constructor(cfg: MeiliConfig) {
    this.cfg = cfg;
  }

  get enabled(): boolean {
    return this.cfg.enabled && Boolean(this.cfg.host);
  }

  private async req(method: string, path: string, body?: unknown): Promise<Response | null> {
    if (!this.enabled) return null;
    try {
      return await fetch(`${this.cfg.host}${path}`, {
        method,
        headers: {
          ...(this.cfg.apiKey ? { authorization: `Bearer ${this.cfg.apiKey}` } : {}),
          ...(body ? { "content-type": "application/json" } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch {
      return null; // Meili unreachable — search is optional, never throw
    }
  }

  /** Create the index (idempotent) + apply its searchable/filterable settings. */
  async ensureIndex(uid: string, settings: IndexSettings): Promise<void> {
    await this.req("POST", "/indexes", { uid, primaryKey: settings.primaryKey ?? "id" });
    await this.req("PATCH", `/indexes/${uid}/settings`, {
      searchableAttributes: settings.searchableAttributes,
      filterableAttributes: settings.filterableAttributes,
      sortableAttributes: settings.sortableAttributes,
      ...(settings.maxValuesPerFacet
        ? { faceting: { maxValuesPerFacet: settings.maxValuesPerFacet } }
        : {}),
    });
  }

  /** Delete an index outright. Best-effort; a missing index is a failed task, not an error. */
  async deleteIndex(uid: string): Promise<number | null> {
    return taskUidOf(await this.req("DELETE", `/indexes/${uid}`));
  }

  /**
   * Atomically exchange two indexes' contents. Both must exist. This is what lets a
   * rebuild fill a side index and then trade places with the one being searched,
   * rather than clearing it and leaving search empty until the refill lands.
   */
  async swapIndexes(a: string, b: string): Promise<number | null> {
    return taskUidOf(await this.req("POST", "/swap-indexes", [{ indexes: [a, b] }]));
  }

  /**
   * Add-or-replace documents by primary key. Best-effort; returns the enqueued task
   * uid so a caller that cares (a deliberate reindex) can confirm the outcome.
   *
   * Meili answers `202 Accepted` and validates **asynchronously**, so a rejected batch
   * looks like success here — see {@link taskFailures}.
   */
  async index(uid: string, docs: Record<string, unknown>[]): Promise<number | null> {
    if (!docs.length) return null;
    return taskUidOf(await this.req("POST", `/indexes/${uid}/documents`, docs));
  }

  /**
   * Wait for the given tasks to finish and report the ones that failed. Indexing is
   * asynchronous, so this is the only way to learn that a batch was rejected —
   * without it a whole reindex can "succeed" and leave the index empty.
   */
  async taskFailures(
    taskUids: number[],
    timeoutMs = 120_000,
  ): Promise<{ indexed: number; failures: string[] }> {
    if (!taskUids.length) return { indexed: 0, failures: [] };
    const deadline = Date.now() + timeoutMs;
    const uids = taskUids.join(",");
    while (Date.now() < deadline) {
      const res = await this.req("GET", `/tasks?uids=${uids}&limit=${taskUids.length}`);
      if (!res?.ok) return { indexed: 0, failures: ["could not read Meilisearch task status"] };
      const json = (await res.json()) as { results?: any[] };
      const tasks = json.results ?? [];
      if (tasks.some((t) => t.status === "enqueued" || t.status === "processing")) {
        await new Promise((r) => setTimeout(r, 250));
        continue;
      }
      const failures = tasks
        .filter((t) => t.status === "failed")
        .map((t) => `${t.type} on ${t.indexUid}: ${t.error?.code} — ${t.error?.message}`);
      const indexed = tasks.reduce((n, t) => n + (t.details?.indexedDocuments ?? 0), 0);
      // Distinct messages only: one rejected batch usually means every batch failed
      // the same way, and the caller wants the cause, not 49 copies of it.
      return { indexed, failures: [...new Set(failures)] };
    }
    return { indexed: 0, failures: ["timed out waiting for Meilisearch to index"] };
  }

  /**
   * Delete finished tasks older than `olderThanMs` from Meilisearch's task queue.
   *
   * Meilisearch keeps every task it has ever run — up to a million before it starts
   * evicting on its own — and the queue lives in the same storage the indexes do, so
   * a follower enqueueing a task every few minutes grows it forever. Only *finished*
   * tasks go, and only old ones, so a reindex still waiting on its own tasks (see
   * {@link taskFailures}) never has them pulled out from under it. Only tasks on
   * `indexUids`, too: a shared Meilisearch's queue holds other deployments' tasks,
   * and those aren't ours to delete (ADR 0028). Best-effort.
   */
  async pruneTasks(indexUids: string[], olderThanMs: number): Promise<number | null> {
    if (!indexUids.length) return null;
    const params = new URLSearchParams({
      statuses: "succeeded,failed,canceled",
      indexUids: indexUids.join(","),
      beforeFinishedAt: new Date(Date.now() - olderThanMs).toISOString(),
    });
    return taskUidOf(await this.req("DELETE", `/tasks?${params}`));
  }

  /**
   * Search one index. Cropping + highlighting (for content snippets) are opt-in and
   * land in each hit's `_formatted`; any failure yields no hits.
   *
   * Returns the estimated total alongside the page, because a results page can't
   * offer paging without knowing whether there is a next page. Meilisearch's count is
   * an estimate by design — it stops counting early on large corpora — so treat it as
   * "about this many", which is what a hit count is for anyway.
   */
  async search(
    uid: string,
    q: string,
    opts: QueryOptions & { limit?: number; offset?: number } = {},
  ): Promise<{ hits: Record<string, unknown>[]; estimatedTotalHits: number }> {
    const body = { ...queryBody(q, opts), limit: opts.limit ?? 20 } as Record<string, unknown>;
    if (opts.offset) body.offset = opts.offset;
    const res = await this.req("POST", `/indexes/${uid}/search`, body);
    if (!res?.ok) return { hits: [], estimatedTotalHits: 0 };
    try {
      const json = (await res.json()) as {
        hits?: Record<string, unknown>[];
        estimatedTotalHits?: number;
      };
      const hits = json.hits ?? [];
      return { hits, estimatedTotalHits: json.estimatedTotalHits ?? hits.length };
    } catch {
      return { hits: [], estimatedTotalHits: 0 };
    }
  }

  /**
   * Search several indexes as one: Meilisearch's federated multi-search (v1.10+) runs
   * the same query on each, ranks every hit on one scale and pages across the merged
   * list. That is what lets one logical corpus live in more than one index — the turn
   * archive and the live turns — without the caller seeing the seam.
   *
   * The indexes must share ranking settings for the merged order to mean anything.
   * Each hit carries `_federation.indexUid`. Any failure yields no hits.
   */
  async federatedSearch(
    uids: string[],
    q: string,
    opts: QueryOptions & { limit?: number; offset?: number } = {},
  ): Promise<{ hits: Record<string, unknown>[]; estimatedTotalHits: number }> {
    const base = queryBody(q, opts);
    const res = await this.req("POST", "/multi-search", {
      federation: { limit: opts.limit ?? 20, offset: opts.offset ?? 0 },
      queries: uids.map((indexUid) => ({ ...base, indexUid })),
    });
    if (!res?.ok) return { hits: [], estimatedTotalHits: 0 };
    try {
      const json = (await res.json()) as {
        hits?: Record<string, unknown>[];
        estimatedTotalHits?: number;
      };
      const hits = json.hits ?? [];
      return { hits, estimatedTotalHits: json.estimatedTotalHits ?? hits.length };
    } catch {
      return { hits: [], estimatedTotalHits: 0 };
    }
  }

  /**
   * Remove documents from an index.
   *
   * Search is derived, so deletions have always been reconcilable by `reindex` — but
   * only by rebuilding *everything*, which is a poor answer for "this one session went
   * away". Removing a session's entries directly is what lets a fixture, or a
   * re-processed session, clean up after itself.
   *
   * `filter` uses the index's filterable attributes; `ids` deletes by primary key.
   * Best-effort like every other call here — a disabled or unreachable engine leaves
   * the index stale, and `reindex` remains the backstop.
   */
  async deleteDocs(
    uid: string,
    target: { ids?: string[]; filter?: string },
  ): Promise<number | null> {
    const res = target.filter
      ? await this.req("POST", `/indexes/${uid}/documents/delete`, { filter: target.filter })
      : target.ids?.length
        ? await this.req("POST", `/indexes/${uid}/documents/delete-batch`, target.ids)
        : null;
    return taskUidOf(res);
  }

  /**
   * The distinct values of a filterable attribute, for building filter controls.
   *
   * Meilisearch returns these from a normal search with `facets`, so this is one empty
   * query rather than a scan. Best-effort: an engine that's down yields no facets and
   * the UI simply offers no filters.
   */
  async facets(uid: string, attributes: string[]): Promise<Record<string, string[]>> {
    const res = await this.req("POST", `/indexes/${uid}/search`, {
      q: "",
      limit: 0,
      facets: attributes,
    });
    if (!res?.ok) return {};
    try {
      const json = (await res.json()) as {
        facetDistribution?: Record<string, Record<string, number>>;
      };
      const out: Record<string, string[]> = {};
      for (const attr of attributes) {
        const dist = json.facetDistribution?.[attr] ?? {};
        out[attr] = Object.keys(dist).filter(Boolean).sort();
      }
      return out;
    } catch {
      return {};
    }
  }
}

/**
 * Build a Meilisearch document id from parts.
 *
 * Meili only accepts `a-zA-Z0-9`, `-` and `_` in a document id, and it enforces that
 * **asynchronously**: a composite id containing anything else (`:` was the original
 * separator here) fails the whole batch with `invalid_document_id` long after the POST
 * returned `202`. Ids must also stay stable across re-ingest so a chunk replaces its
 * turns instead of duplicating them — hence a pure function of the parts.
 */
export function searchDocId(...parts: (string | number)[]): string {
  return parts.map((p) => String(p).replace(/[^a-zA-Z0-9_-]/g, "_")).join("_");
}

/** The Meilisearch index holding one document per session (metadata search). */
/**
 * Logical index keys. The *names* live in `config/` (`meilisearch.indexes`) and are
 * resolved with `indexName()` — namespaced like the databases and buckets, so a
 * deployment pointed at a shared Meilisearch can neither collide with another one nor
 * have its indexes cleared by someone else's rebuild (ADR 0028).
 */
export const SESSIONS_INDEX_KEY = "sessions";

/** Index settings for the sessions index. */
export const SESSIONS_INDEX_SETTINGS: IndexSettings = {
  primaryKey: "id",
  searchableAttributes: ["cwd", "model", "hostname", "endReason", "tools", "sessionId"],
  filterableAttributes: ["cwd", "model", "hostname", "endReason", "source"],
  sortableAttributes: ["timestamp"],
};

/** Project a stored `summary:` doc into a Meilisearch session document. */
export function toSessionSearchDoc(doc: any): Record<string, unknown> {
  return {
    id: searchDocId(doc.session_id),
    sessionId: doc.session_id,
    timestamp: doc.timestamp,
    cwd: doc.cwd ?? "",
    model: doc.model ?? "",
    hostname: doc.hostname ?? "",
    endReason: doc.end_reason ?? "",
    source: doc.source ?? "live",
    tools: Object.keys(doc.tool_counts ?? {}),
    promptCount: doc.prompt_count ?? 0,
    eventCount: doc.event_count ?? 0,
  };
}

/**
 * Conversation turns live in two indexes, split by whether their session is over
 * (ADR 0032). Meilisearch's cost per update grows with the size of the index it lands
 * in (#231), so the large, settled corpus goes in an archive that is written rarely,
 * and the turns still arriving go in a small live index that is cheap to write often.
 * Search queries both as one ({@link Meili.federatedSearch}).
 *
 * The archive: every turn of every ended session. Its config key stays `turns`, so a
 * deployment upgrading keeps its existing index as the archive.
 */
export const TURNS_INDEX_KEY = "turns";

/** The live turns index: turns of sessions that are still running. */
export const LIVE_TURNS_INDEX_KEY = "liveTurns";

export const TURNS_INDEX_SETTINGS: IndexSettings = {
  primaryKey: "id",
  searchableAttributes: ["text"],
  filterableAttributes: ["role", "sessionId", "cwd"],
  sortableAttributes: ["timestamp"],
};

/**
 * The live index's settings: the archive's, so federated ranking compares like with
 * like, plus room to facet on `sessionId` — that facet is how the maintenance pass
 * learns which sessions the live index still holds.
 */
export const LIVE_TURNS_INDEX_SETTINGS: IndexSettings = {
  ...TURNS_INDEX_SETTINGS,
  maxValuesPerFacet: 10_000,
};

/**
 * Project a full-content `chunk` doc into per-turn Meilisearch documents — one per
 * `entries[]` turn that has text. Ids are stable (`<session>:<byteStart>:<index>`)
 * so re-ingesting a chunk replaces, not duplicates. Empty for byte-range-only chunks.
 */
/**
 * Project a session that has **no summary doc yet** into the sessions index.
 *
 * The index was built from `summary` docs alone, so a session that hasn't ended simply
 * wasn't findable — its *turns* were searchable while the session itself was not, which
 * is exactly backwards for the case you'd search during: work in progress. A crashed
 * session (started, never ended) was invisible for good.
 *
 * The `session_index/aggregate` row carries everything the index needs, accumulated
 * from the event docs. `endReason` is deliberately empty rather than invented — the
 * session hasn't ended — and `source` says "live", since only a live hook writes a
 * session that has no summary yet.
 *
 * Ended sessions keep coming from their summary doc ({@link toSessionSearchDoc}): equal
 * fidelity, and no risk of a partial row replacing a complete one.
 */
export function toRunningSessionSearchDoc(sessionId: string, agg: any): Record<string, unknown> {
  return {
    id: searchDocId(sessionId),
    sessionId,
    // Most-recent activity: what you'd sort a live session by.
    timestamp: agg?.last || agg?.first || "",
    cwd: agg?.cwd ?? "",
    model: agg?.model ?? "",
    hostname: agg?.hostname ?? "",
    endReason: "",
    source: "live",
    tools: Object.keys(agg?.tools ?? {}),
    promptCount: agg?.prompts ?? 0,
    eventCount: agg?.events ?? 0,
  };
}

/** Roles that represent something a person or the model actually said. */
const CONVERSATION_ROLES = new Set(["user", "assistant", "tool_result"]);

export function toTurnSearchDocs(doc: any): Record<string, unknown>[] {
  const entries: any[] = Array.isArray(doc.entries) ? doc.entries : [];
  const out: Record<string, unknown>[] = [];
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    const text: string = typeof e?.text === "string" ? e.text : "";
    if (!text) continue;
    // Conversation turns only. Non-message lines (attachments, mode changes, file
    // history) now carry a summary so they don't render blank — but they are context,
    // not content, and there are more of them than user turns. Indexing them would
    // bury real matches under a thousand identical "hook_success" rows.
    if (!CONVERSATION_ROLES.has(e?.role)) continue;
    out.push({
      id: searchDocId(doc.session_id, doc.byte_start, i),
      sessionId: doc.session_id,
      role: e.role ?? "other",
      text,
      timestamp: e.timestamp ?? doc.timestamp ?? "",
      cwd: doc.cwd ?? "",
    });
  }
  return out;
}

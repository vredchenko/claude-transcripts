/**
 * Minimal Meilisearch client (fetch-based, no SDK) for full-text session search
 * (ADR 0009). Search is **optional**: every call is best-effort and swallows errors,
 * so a down or absent Meilisearch never breaks ingest or the rest of the app. Gated
 * by `features.meilisearch` + `MEILI_HOST`; in the bundled dev stack Meili runs with
 * no master key, so `apiKey` is optional.
 */

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
    });
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
    const res = await this.req("POST", `/indexes/${uid}/documents`, docs);
    if (!res?.ok) return null;
    try {
      const json = (await res.json()) as { taskUid?: number };
      return typeof json.taskUid === "number" ? json.taskUid : null;
    } catch {
      return null;
    }
  }

  /** Delete every document in an index, so a rebuild starts from empty. Best-effort. */
  async clear(uid: string): Promise<number | null> {
    const res = await this.req("DELETE", `/indexes/${uid}/documents`);
    if (!res?.ok) return null;
    try {
      const json = (await res.json()) as { taskUid?: number };
      return typeof json.taskUid === "number" ? json.taskUid : null;
    } catch {
      return null;
    }
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

  /** Search an index; returns the hits array (empty on any failure). Cropping +
   *  highlighting (for content snippets) are opt-in and land in each hit's
   *  `_formatted`. */
  async search(
    uid: string,
    q: string,
    opts: {
      limit?: number;
      attributesToCrop?: string[];
      cropLength?: number;
      attributesToHighlight?: string[];
    } = {},
  ): Promise<Record<string, unknown>[]> {
    const body: Record<string, unknown> = { q, limit: opts.limit ?? 20 };
    if (opts.attributesToCrop) body.attributesToCrop = opts.attributesToCrop;
    if (opts.cropLength) body.cropLength = opts.cropLength;
    if (opts.attributesToHighlight) body.attributesToHighlight = opts.attributesToHighlight;
    const res = await this.req("POST", `/indexes/${uid}/search`, body);
    if (!res?.ok) return [];
    try {
      const json = (await res.json()) as { hits?: Record<string, unknown>[] };
      return json.hits ?? [];
    } catch {
      return [];
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
export const SESSIONS_INDEX = "sessions";

/** Index settings for the sessions index. */
export const SESSIONS_INDEX_SETTINGS: IndexSettings = {
  primaryKey: "id",
  searchableAttributes: ["cwd", "model", "hostname", "endReason", "tools", "sessionId"],
  filterableAttributes: ["model", "hostname", "endReason", "source"],
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

/** The Meilisearch index holding one document per conversation turn (content search). */
export const TURNS_INDEX = "turns";

export const TURNS_INDEX_SETTINGS: IndexSettings = {
  primaryKey: "id",
  searchableAttributes: ["text"],
  filterableAttributes: ["role", "sessionId", "cwd"],
  sortableAttributes: ["timestamp"],
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

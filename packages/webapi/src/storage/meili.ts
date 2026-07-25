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

  /** Add-or-replace documents by primary key. Best-effort. */
  async index(uid: string, docs: Record<string, unknown>[]): Promise<void> {
    if (!docs.length) return;
    await this.req("POST", `/indexes/${uid}/documents`, docs);
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
    if (!res || !res.ok) return [];
    try {
      const json = (await res.json()) as { hits?: Record<string, unknown>[] };
      return json.hits ?? [];
    } catch {
      return [];
    }
  }
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
    id: doc.session_id,
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
export function toTurnSearchDocs(doc: any): Record<string, unknown>[] {
  const entries: any[] = Array.isArray(doc.entries) ? doc.entries : [];
  const out: Record<string, unknown>[] = [];
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    const text: string = typeof e?.text === "string" ? e.text : "";
    if (!text) continue;
    out.push({
      id: `${doc.session_id}:${doc.byte_start}:${i}`,
      sessionId: doc.session_id,
      role: e.role ?? "other",
      text,
      timestamp: e.timestamp ?? doc.timestamp ?? "",
      cwd: doc.cwd ?? "",
    });
  }
  return out;
}

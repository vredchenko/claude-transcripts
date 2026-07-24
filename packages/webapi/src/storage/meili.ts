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

  /** Search an index; returns the hits array (empty on any failure). */
  async search(
    uid: string,
    q: string,
    opts: { limit?: number } = {},
  ): Promise<Record<string, unknown>[]> {
    const res = await this.req("POST", `/indexes/${uid}/search`, { q, limit: opts.limit ?? 20 });
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

/**
 * CouchDB client for the hook. Every call is wrapped with a short timeout —
 * CouchDB failures must never block a session. Databases are addressed by name
 * (the keyed config resolves logical keys → names).
 */
import type { HookConfig } from "./config";

export interface CouchClient {
  /** POST a new doc to `db` (CouchDB assigns the id). */
  postDoc(db: string, doc: object): Promise<void>;
  /** PUT a doc at a known id in `db`; returns the new rev (or null on failure). */
  putDoc(db: string, id: string, doc: object, timeoutMs?: number): Promise<{ rev?: string } | null>;
}

export function makeCouch(config: HookConfig): CouchClient {
  const root = config.couch.url;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  // Bundled dev is no-auth (empty auth) — only send the header when configured.
  if (config.couch.auth) headers.Authorization = `Basic ${btoa(config.couch.auth)}`;

  return {
    async postDoc(db, doc) {
      try {
        await fetch(`${root}/${db}`, {
          method: "POST",
          headers,
          body: JSON.stringify(doc),
          signal: AbortSignal.timeout(4000),
        });
      } catch {
        // non-fatal
      }
    },

    async putDoc(db, id, doc, timeoutMs = 4000) {
      try {
        const resp = await fetch(`${root}/${db}/${encodeURIComponent(id)}`, {
          method: "PUT",
          headers,
          body: JSON.stringify(doc),
          signal: AbortSignal.timeout(timeoutMs),
        });
        return resp.ok ? ((await resp.json()) as { rev?: string }) : null;
      } catch {
        return null;
      }
    },
  };
}

/**
 * Concrete {@link MigrationContext} over a `nano` database scope — the webapi is
 * the I/O gateway, so the migration engine's actual CouchDB writes live here (the
 * CLI drives migrations through the webapi, never touching CouchDB directly).
 */
import type { MigrationContext } from "@claude-transcripts/shared";
import type { DocumentScope } from "nano";

function statusCode(err: unknown): number | undefined {
  return (err as { statusCode?: number })?.statusCode;
}

/** Build a migration context bound to `db`, routing progress lines to `log`. */
export function makeMigrationContext(
  db: DocumentScope<unknown>,
  log: (message: string) => void,
): MigrationContext {
  return {
    async getDoc<T = Record<string, unknown>>(id: string): Promise<T | null> {
      try {
        return (await db.get(id)) as unknown as T;
      } catch (err) {
        if (statusCode(err) === 404) return null;
        throw err;
      }
    },

    async putDoc(id: string, doc: Record<string, unknown>): Promise<void> {
      let rev: string | undefined;
      try {
        const existing = await db.get(id);
        rev = (existing as { _rev?: string })._rev;
      } catch (err) {
        if (statusCode(err) !== 404) throw err;
      }
      const body = rev ? { ...doc, _rev: rev } : { ...doc };
      await db.insert(body as Record<string, unknown>, id);
    },

    async deleteDoc(id: string): Promise<void> {
      try {
        const existing = await db.get(id);
        await db.destroy(id, (existing as { _rev: string })._rev);
      } catch (err) {
        if (statusCode(err) !== 404) throw err;
      }
    },

    async allDocs<T = Record<string, unknown>>(opts?: {
      startkey?: string;
      endkey?: string;
    }): Promise<T[]> {
      const res = await db.list({
        include_docs: true,
        ...(opts?.startkey !== undefined ? { startkey: opts.startkey } : {}),
        ...(opts?.endkey !== undefined ? { endkey: opts.endkey } : {}),
      });
      return res.rows.filter((r) => r.doc).map((r) => r.doc as unknown as T);
    },

    now: () => new Date().toISOString(),
    log,
  };
}

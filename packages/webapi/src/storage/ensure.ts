/**
 * Boot-time CouchDB schema setup: create the configured databases, then bring the
 * sessions database up to the latest schema version via the self-built migration
 * engine (ADR 0021). Idempotent and non-blocking — startup continues on failure.
 *
 * The map-reduce design views are no longer defined here: they live in the initial
 * migration (`@claude-transcripts/shared` migrations → `INITIAL_DESIGNS`), so views can
 * never drift from the versioned path. `migrate up`/`down` (CLI) and this boot path
 * share one engine.
 */
import { migrateUp } from "@claude-transcripts/shared";
import type { Config } from "../config";
import type { CouchHandles } from "./couch";
import { makeMigrationContext } from "./migrations";

export async function ensureCouchDbs(couch: CouchHandles, config: Config): Promise<void> {
  // Create every configured database (sessions, appLogs, …). Idempotent.
  for (const name of Object.values(config.couchdb.databases)) {
    try {
      await couch.server.db.create(name);
    } catch (err) {
      if ((err as { statusCode?: number }).statusCode !== 412) throw err;
    }
  }

  // The `session_index` view (migration v2) uses an object-accumulating reduce; on
  // the bundled single-node CouchDB, relax the reduce-overflow guard so it isn't
  // rejected (its output is bounded per session). Best-effort + non-fatal — a
  // managed/multi-node CouchDB may have this locked or preset.
  try {
    await fetch(`${couch.url}/_node/_local/_config/query_server_config/reduce_limit`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: '"false"',
    });
  } catch {
    // ignore — see the per-session bound noted in migrations/session-index.ts
  }

  // Apply pending migrations to the sessions DB (installs design views + marker).
  const sessions = couch.db("sessions");
  const mig = makeMigrationContext(sessions, (m) => console.log(`[migrate] ${m}`));
  const result = await migrateUp(mig);
  if (result.applied.length > 0) {
    console.log(`[migrate] sessions DB → v${result.toVersion} (${result.applied.length} applied)`);
  }

  // Mango index on `type` — non-fatal optimisation.
  try {
    await sessions.createIndex({ index: { fields: ["type"] }, name: "idx-type", type: "json" });
  } catch {
    // ignore — index is an optimisation, not required for correctness
  }
}

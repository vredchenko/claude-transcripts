/**
 * The ordered migration registry. Append new migrations here with the next id;
 * never renumber or edit an already-released migration's `up` (add a new one).
 */
import { INITIAL_DESIGNS } from "./designs";
import { SESSION_INDEX_DESIGN } from "./session-index";
import type { Migration } from "./types";

/**
 * v1 — install the initial map-reduce design views on the sessions database.
 * `up` upserts every design doc (idempotent); `down` removes them. This subsumes
 * the former boot-time `ensure.ts` view sync into the versioned path (ADR 0021).
 */
const initialSchema: Migration = {
  id: 1,
  name: "initial-schema",
  async up(ctx) {
    for (const design of INITIAL_DESIGNS) {
      ctx.log(`+ ${design._id}`);
      // Strip any stale _rev from the definition; putDoc carries the live one.
      const { _rev, ...body } = design;
      await ctx.putDoc(design._id, body as Record<string, unknown>);
    }
  },
  async down(ctx) {
    for (const design of INITIAL_DESIGNS) {
      ctx.log(`- ${design._id}`);
      await ctx.deleteDoc(design._id);
    }
  },
};

/**
 * v2 — add `_design/session_index`, the per-session aggregate view that lets the
 * reader surface `running`/`incomplete` sessions (started but no `summary` doc yet),
 * not just ended ones. `up` upserts the design; `down` removes it.
 */
const sessionIndexView: Migration = {
  id: 2,
  name: "session-index-view",
  async up(ctx) {
    ctx.log(`+ ${SESSION_INDEX_DESIGN._id}`);
    const { _rev, ...body } = SESSION_INDEX_DESIGN;
    await ctx.putDoc(SESSION_INDEX_DESIGN._id, body as Record<string, unknown>);
  },
  async down(ctx) {
    ctx.log(`- ${SESSION_INDEX_DESIGN._id}`);
    await ctx.deleteDoc(SESSION_INDEX_DESIGN._id);
  },
};

/**
 * v3 — redeploy `_design/session_index` so its `aggregate` view additionally emits
 * `summary.source` (session provenance: live / backfill / doctor). The map now
 * carries the field; the reduce already copies the whole summary object, so no
 * reduce change is needed. Re-putting the design triggers a lazy reindex on the
 * next query. `down` is a no-op — the added field is additive and harmless, and v2
 * still owns the design doc's existence.
 */
const sessionIndexSource: Migration = {
  id: 3,
  name: "session-index-source",
  async up(ctx) {
    ctx.log(`~ ${SESSION_INDEX_DESIGN._id} (emit summary.source)`);
    const { _rev, ...body } = SESSION_INDEX_DESIGN;
    await ctx.putDoc(SESSION_INDEX_DESIGN._id, body as Record<string, unknown>);
  },
  async down(ctx) {
    ctx.log(`~ ${SESSION_INDEX_DESIGN._id} (source field left in place — additive)`);
  },
};

/** All migrations, ascending by id. `latestVersion` is the last entry's id. */
export const MIGRATIONS: Migration[] = [initialSchema, sessionIndexView, sessionIndexSource];

/** The highest migration id in the registry (the target for `up` with no `--to`). */
export function latestVersion(): number {
  return MIGRATIONS.reduce((max, m) => Math.max(max, m.id), 0);
}

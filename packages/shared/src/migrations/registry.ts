/**
 * The ordered migration registry. Append new migrations here with the next id;
 * never renumber or edit an already-released migration's `up` (add a new one).
 */
import { CHUNKS_DESIGN, INITIAL_DESIGNS } from "./designs";
import { SESSION_INDEX_DESIGN } from "./session-index";
import { SPEAKER_SPLIT_DESIGN } from "./speaker-split";
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

/**
 * v4 — add `_design/speaker_split`, a per-turn view over full-content `chunk` docs
 * that lets a reader pull just the user's turns or just Claude's turns for a session
 * (ADR 0027). `up` upserts the design; `down` removes it. Only content chunks
 * (`entries[]`, `couchFullContentChunks`) populate it; byte-range-only chunks are
 * skipped, so it's empty until content chunks exist.
 */
const speakerSplitView: Migration = {
  id: 4,
  name: "speaker-split-view",
  async up(ctx) {
    ctx.log(`+ ${SPEAKER_SPLIT_DESIGN._id}`);
    const { _rev, ...body } = SPEAKER_SPLIT_DESIGN;
    await ctx.putDoc(SPEAKER_SPLIT_DESIGN._id, body as Record<string, unknown>);
  },
  async down(ctx) {
    ctx.log(`- ${SPEAKER_SPLIT_DESIGN._id}`);
    await ctx.deleteDoc(SPEAKER_SPLIT_DESIGN._id);
  },
};

/**
 * v5 — redeploy `_design/speaker_split` to add the `by_role_time` view (turns
 * re-keyed `[role, timestamp, session_id, …]` for cross-session, time-ordered
 * reading — every turn of one speaker across all sessions). Re-putting the design
 * (now carrying both views) triggers a lazy reindex. `down` is a no-op — the added
 * view is additive and harmless; v4 still owns the design doc's existence.
 */
const speakerSplitTimeView: Migration = {
  id: 5,
  name: "speaker-split-time-view",
  async up(ctx) {
    ctx.log(`~ ${SPEAKER_SPLIT_DESIGN._id} (add by_role_time)`);
    const { _rev, ...body } = SPEAKER_SPLIT_DESIGN;
    await ctx.putDoc(SPEAKER_SPLIT_DESIGN._id, body as Record<string, unknown>);
  },
  async down(ctx) {
    ctx.log(`~ ${SPEAKER_SPLIT_DESIGN._id} (by_role_time left in place — additive)`);
  },
};

/**
 * v6 — redeploy `_design/chunks` to add `entries_by_session`: the session's turns
 * keyed `[session_id, byte_start, entry_index]`, i.e. the transcript in reading order
 * across all speakers. This makes the chunk docs the primary read path for
 * `GET /api/sessions/{id}/transcript`, so a transcript is readable mid-session
 * (chunks flush as the session runs) instead of only after the SessionEnd S3 upload.
 * Re-putting the design triggers a lazy reindex. `down` is a no-op — the added view is
 * additive and harmless; v1 still owns the design doc's existence.
 */
const chunkEntriesView: Migration = {
  id: 6,
  name: "chunk-entries-view",
  async up(ctx) {
    ctx.log(`~ ${CHUNKS_DESIGN._id} (add entries_by_session)`);
    const { _rev, ...body } = CHUNKS_DESIGN;
    await ctx.putDoc(CHUNKS_DESIGN._id, body as Record<string, unknown>);
  },
  async down(ctx) {
    ctx.log(`~ ${CHUNKS_DESIGN._id} (entries_by_session left in place — additive)`);
  },
};

/**
 * v7 — redeploy `_design/session_index` so its `aggregate` view also carries chunk
 * coverage (`chunkEntries` / `chunkBytes`). Without it the reader can only report
 * `hasTranscript` from a `summary` doc's `transcript_bytes`, which hides the
 * transcript of any session that hasn't ended (or that crashed before SessionEnd)
 * even when its chunks hold the content. Additive to the emitted value; `down` is a
 * no-op and v2 still owns the design doc's existence.
 */
const sessionIndexChunkCoverage: Migration = {
  id: 7,
  name: "session-index-chunk-coverage",
  async up(ctx) {
    ctx.log(`~ ${SESSION_INDEX_DESIGN._id} (emit chunk coverage)`);
    const { _rev, ...body } = SESSION_INDEX_DESIGN;
    await ctx.putDoc(SESSION_INDEX_DESIGN._id, body as Record<string, unknown>);
  },
  async down(ctx) {
    ctx.log(`~ ${SESSION_INDEX_DESIGN._id} (chunk coverage left in place — additive)`);
  },
};

/** All migrations, ascending by id. `latestVersion` is the last entry's id. */
export const MIGRATIONS: Migration[] = [
  initialSchema,
  sessionIndexView,
  sessionIndexSource,
  speakerSplitView,
  speakerSplitTimeView,
  chunkEntriesView,
  sessionIndexChunkCoverage,
];

/** The highest migration id in the registry (the target for `up` with no `--to`). */
export function latestVersion(): number {
  return MIGRATIONS.reduce((max, m) => Math.max(max, m.id), 0);
}

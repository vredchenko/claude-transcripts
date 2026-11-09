/**
 * The CouchDB doc schemas — one definition for every party that writes or checks a
 * session's docs (docs/reference/couchdb.md).
 *
 * The webapi validates `/api/ingest/*` bodies against these schemas, and the CLI's doc
 * builders (backfill, doctor, reconcile) are typed by what they infer, so the writer
 * and the gateway's validator cannot drift apart. Stored shape, so snake_case.
 *
 * A subpath export (`@claude-transcripts/shared/docs`) rather than part of the root
 * barrel: the schemas are runtime zod, and the webui, which imports the root, has no
 * use for them. A type-only import of this module costs nothing at runtime.
 *
 * The objects are passthrough: a doc may carry fields beyond the ones listed (an event
 * doc's per-event markers, a summary's provenance), and they are stored as sent.
 */
import { z } from "zod";

export const TokenUsageSchema = z.object({
  input: z.number(),
  output: z.number(),
  cacheCreation: z.number(),
  cacheRead: z.number(),
  total: z.number(),
  messages: z.number(),
});

/** A `summary:<id>` doc — the session rollup written at `SessionEnd`. */
export const SummaryDocSchema = z
  .object({
    _id: z.string(),
    type: z.literal("summary"),
    event: z.literal("SessionEnd"),
    session_id: z.string(),
    timestamp: z.string(),
    hostname: z.string(),
    cwd: z.string(),
    model: z.string().optional(),
    end_reason: z.string(),
    event_count: z.number(),
    prompt_count: z.number(),
    error_count: z.number(),
    tool_counts: z.record(z.string(), z.number()),
    transcript_bytes: z.number(),
    // Optional for `reconcile`: a session that never ended has no transcript in S3 to
    // count tokens from, and a zero would read as a measurement.
    token_usage: TokenUsageSchema.optional(),
    // Provenance: "live" (hook) | "backfill" (adopted from fs) | "reconcile" (finalised
    // after the fact). Kept open (string) so it's not brittle as sources evolve.
    source: z.string().optional(),
    backfilled_at: z.string().optional(),
    actor: z.string().optional(),
  })
  .passthrough();

/** A per-event marker doc — one per hook event. */
export const EventDocSchema = z
  .object({
    type: z.literal("event"),
    event: z.string(),
    session_id: z.string(),
    timestamp: z.string(),
    hostname: z.string(),
    cwd: z.string(),
  })
  .passthrough(); // event-specific marker fields

// A parsed transcript turn embedded in a full-content chunk (ADR 0027). Present
// only when `couchFullContentChunks` is on; kept permissive as the shape evolves.
export const ChunkEntrySchema = z
  .object({
    role: z.enum(["user", "assistant", "tool_result", "system", "other"]),
    timestamp: z.string().optional(),
    text: z.string().optional(),
    toolUses: z.array(z.object({ name: z.string(), id: z.string().optional() })).optional(),
    toolUseId: z.string().optional(),
    isError: z.boolean().optional(),
    isSidechain: z.boolean().optional(),
  })
  .passthrough();

/** A `chunk:<id>:<byte_start>` doc — a byte-faithful slice of the transcript. */
export const ChunkDocSchema = z
  .object({
    _id: z.string(),
    type: z.literal("chunk"),
    session_id: z.string(),
    byte_start: z.number(),
    byte_end: z.number(),
    entry_count: z.number(),
    timestamp: z.string(),
    hostname: z.string(),
    cwd: z.string(),
    schema_version: z.number(),
    entries: z.array(ChunkEntrySchema).optional(),
  })
  .passthrough();

export type SummaryDoc = z.infer<typeof SummaryDocSchema>;
export type EventDoc = z.infer<typeof EventDocSchema>;
export type ChunkDoc = z.infer<typeof ChunkDocSchema>;
/** A chunk entry as the validator sees it; the projector's own type is `ChunkEntry`. */
export type ChunkEntryDoc = z.infer<typeof ChunkEntrySchema>;

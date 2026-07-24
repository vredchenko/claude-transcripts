import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { bucketName } from "../config";
import type { AppContext } from "../context";

/**
 * Ingest — the curated WRITE surface of the gateway (ADR 0016). Reads are proxied;
 * writes are NOT — they land here, validated, and only here. The host-side CLI
 * (backfill, packages/cli) reads local transcripts the container can't see
 * and delivers the derived docs + blob to these endpoints.
 *
 *   POST /api/ingest/summary          idempotent upsert of a summary:<id> doc
 *   POST /api/ingest/events           bulk-insert append-only event docs
 *   POST /api/ingest/chunks           bulk-insert chunk docs (stable ids; idempotent)
 *   PUT  /api/ingest/{id}/transcript  store the transcript blob in S3 (ADR 0014)
 *
 * TODO(#6): promote these doc schemas to a shared @claude-transcripts/shared module (with the
 * hook) so the hook, webapi, and CLI validate against ONE definition.
 */

// ── Doc schemas (validation-on-write; snake_case stored shape) ──────────────────

const TokenUsageSchema = z.object({
  input: z.number(),
  output: z.number(),
  cacheCreation: z.number(),
  cacheRead: z.number(),
  total: z.number(),
  messages: z.number(),
});

const SummaryDocSchema = z
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
    token_usage: TokenUsageSchema,
    // Provenance: "live" (hook) | "backfill" (adopted from fs). Kept open (string)
    // so it's not brittle as sources evolve.
    source: z.string().optional(),
    backfilled_at: z.string().optional(),
    actor: z.string().optional(),
  })
  .passthrough();

const EventDocSchema = z
  .object({
    type: z.literal("event"),
    event: z.string(),
    session_id: z.string(),
    timestamp: z.string(),
    hostname: z.string(),
    cwd: z.string(),
  })
  .passthrough(); // event-specific marker fields

const EventsBodySchema = z.object({ docs: z.array(EventDocSchema) });

// A parsed transcript turn embedded in a full-content chunk (ADR 0027). Present
// only when `couchFullContentChunks` is on; kept permissive as the shape evolves.
const ChunkEntrySchema = z
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

const ChunkDocSchema = z
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

const ChunksBodySchema = z.object({ docs: z.array(ChunkDocSchema) });

const ResultSchema = z.object({
  ok: z.boolean(),
  id: z.string().optional(),
  updated: z.boolean().optional(),
  inserted: z.number().optional(),
  bytes: z.number().optional(),
});
const ErrorSchema = z.object({ error: z.string() });

// ── Routes ──────────────────────────────────────────────────────────────────────

const summaryRoute = createRoute({
  method: "post",
  path: "/ingest/summary",
  operationId: "ingestSummary",
  request: {
    body: { content: { "application/json": { schema: SummaryDocSchema } }, required: true },
  },
  responses: {
    200: { content: { "application/json": { schema: ResultSchema } }, description: "Upserted" },
    400: { content: { "application/json": { schema: ErrorSchema } }, description: "Invalid doc" },
    500: { content: { "application/json": { schema: ErrorSchema } }, description: "Error" },
  },
});

const eventsRoute = createRoute({
  method: "post",
  path: "/ingest/events",
  operationId: "ingestEvents",
  request: {
    body: { content: { "application/json": { schema: EventsBodySchema } }, required: true },
  },
  responses: {
    200: { content: { "application/json": { schema: ResultSchema } }, description: "Inserted" },
    400: { content: { "application/json": { schema: ErrorSchema } }, description: "Invalid docs" },
    500: { content: { "application/json": { schema: ErrorSchema } }, description: "Error" },
  },
});

const chunksRoute = createRoute({
  method: "post",
  path: "/ingest/chunks",
  operationId: "ingestChunks",
  request: {
    body: { content: { "application/json": { schema: ChunksBodySchema } }, required: true },
  },
  responses: {
    200: { content: { "application/json": { schema: ResultSchema } }, description: "Inserted" },
    400: { content: { "application/json": { schema: ErrorSchema } }, description: "Invalid docs" },
    500: { content: { "application/json": { schema: ErrorSchema } }, description: "Error" },
  },
});

const transcriptRoute = createRoute({
  method: "put",
  path: "/ingest/{id}/transcript",
  operationId: "ingestTranscript",
  // Body is raw JSONL (application/x-ndjson). It's read as text in the handler and
  // deliberately NOT declared as a validated body — the OpenAPI body validator only
  // handles json/form, and would mis-parse raw NDJSON. Documented via the summary.
  summary: "Store a session transcript (raw JSONL body, application/x-ndjson) in S3",
  request: {
    params: z.object({ id: z.string() }),
  },
  responses: {
    200: { content: { "application/json": { schema: ResultSchema } }, description: "Stored" },
    400: { content: { "application/json": { schema: ErrorSchema } }, description: "Empty body" },
    500: { content: { "application/json": { schema: ErrorSchema } }, description: "Error" },
  },
});

export function ingestRoutes(ctx: AppContext) {
  // Loose-typed (matches sessions.ts) so CouchDB's `any` docs don't fight the types.
  const app = new OpenAPIHono();
  const route = app as unknown as {
    openapi: (r: unknown, h: (c: any) => unknown) => void;
  };

  // Idempotent upsert: a session's summary has a stable id, so re-ingest carries
  // the current _rev forward rather than 409-conflicting.
  route.openapi(summaryRoute, async (c: any) => {
    const doc = c.req.valid("json");
    const id: string = doc._id ?? `summary:${doc.session_id}`;
    const db = ctx.couch.db("sessions");
    let rev: string | undefined;
    try {
      rev = (await db.get(id))._rev;
    } catch (err: any) {
      if (err?.statusCode !== 404) throw err;
    }
    await db.insert(rev ? { ...doc, _id: id, _rev: rev } : { ...doc, _id: id });
    return c.json({ ok: true, id, updated: rev !== undefined });
  });

  // Append-only: event docs get CouchDB-assigned ids (no _id in the body).
  route.openapi(eventsRoute, async (c: any) => {
    const { docs } = c.req.valid("json");
    if (!docs.length) return c.json({ ok: true, inserted: 0 });
    const res = await ctx.couch.db("sessions").bulk({ docs });
    const inserted = Array.isArray(res) ? res.filter((r: any) => !r.error).length : docs.length;
    return c.json({ ok: true, inserted });
  });

  // Chunk docs carry stable ids (chunk:<id>:<byte_start>), so a re-ingest just
  // conflicts — treated as already-present (append-only, byte-faithful).
  route.openapi(chunksRoute, async (c: any) => {
    const { docs } = c.req.valid("json");
    if (!docs.length) return c.json({ ok: true, inserted: 0 });
    const res = await ctx.couch.db("sessions").bulk({ docs });
    const inserted = Array.isArray(res) ? res.filter((r: any) => !r.error).length : docs.length;
    return c.json({ ok: true, inserted });
  });

  // Transcript bytes live in S3 only (ADR 0014), under <id>/transcript.jsonl.
  route.openapi(transcriptRoute, async (c: any) => {
    const id = c.req.param("id");
    const text = await c.req.text();
    if (!text || !text.trim()) return c.json({ error: "Empty transcript body" }, 400);
    const bucket = bucketName(ctx.config, "sessions");
    await ctx.blob.put(
      bucket,
      `${id}/transcript.jsonl`,
      new TextEncoder().encode(text),
      "application/x-ndjson",
    );
    return c.json({ ok: true, id, bytes: text.length });
  });

  return app;
}

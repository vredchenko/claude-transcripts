import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { bucketName, indexName } from "../config";
import type { AppContext } from "../context";
import {
  SESSIONS_INDEX_KEY,
  searchDocId,
  TURNS_INDEX_KEY,
  toSessionSearchDoc,
  toTurnSearchDocs,
} from "../storage/meili";
import { validationHook } from "./validation";

/**
 * Ingest — the curated WRITE surface of the gateway (ADR 0016). Reads are proxied;
 * writes are NOT — they land here, validated, and only here. The host-side CLI
 * (backfill, packages/cli) reads local transcripts the container can't see
 * and delivers the derived docs + blob to these endpoints.
 *
 *   POST   /api/ingest/summary          idempotent upsert of a summary:<id> doc
 *   POST   /api/ingest/events           bulk-insert append-only event docs
 *   POST   /api/ingest/chunks           bulk-insert chunk docs (stable ids; idempotent)
 *   PUT    /api/ingest/{id}/transcript  store the transcript blob in S3 (ADR 0014)
 *   DELETE /api/ingest/{id}             drop a session's derived docs, to re-ingest it
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

const ResetResultSchema = z
  .object({
    ok: z.boolean(),
    id: z.string(),
    deleted: z.object({
      summary: z.number(),
      events: z.number(),
      chunks: z.number(),
      /** 1 when the transcript blob was removed too (only with `?blobs=true`). */
      blobs: z.number(),
    }),
  })
  .openapi("SessionResetResult");

/**
 * Delete a session's derived documents so it can be ingested again from scratch.
 *
 * Re-ingesting over the top does **not** work, which is the whole reason this exists:
 * a summary upserts, but event docs get CouchDB-assigned ids and would duplicate, and
 * chunk ids are keyed by byte offset — so a session re-chunked differently (say
 * byte-range-only chunks rebuilt with full content, or a different `--chunk-size`)
 * would leave the old chunks in place alongside the new ones and read back doubled.
 *
 * Deliberately narrow: it removes only what can be regenerated from the transcript.
 * The S3 blob stays (re-ingest overwrites it, and it's the durable original — ADR
 * 0014), so a reset can never lose the one thing that isn't derived.
 */
const resetRoute = createRoute({
  method: "delete",
  path: "/ingest/{id}",
  operationId: "resetSession",
  summary: "Delete a session's summary/event/chunk docs so it can be re-ingested",
  request: {
    params: z.object({ id: z.string() }),
    query: z.object({
      /**
       * Also delete the S3 transcript. Off by default: the blob is the one part of a
       * session that isn't derived, and re-ingest overwrites it anyway — so
       * `backfill --force` must not lose it. Tests and other throwaway fixtures want
       * the session gone entirely, and ask for it explicitly.
       */
      blobs: z.enum(["true", "false"]).optional(),
    }),
  },
  responses: {
    200: {
      content: { "application/json": { schema: ResetResultSchema } },
      description: "Deleted",
    },
    400: { content: { "application/json": { schema: ErrorSchema } }, description: "Bad request" },
    500: { content: { "application/json": { schema: ErrorSchema } }, description: "Error" },
  },
});

export function ingestRoutes(ctx: AppContext) {
  // Loose-typed (matches sessions.ts) so CouchDB's `any` docs don't fight the types.
  const app = new OpenAPIHono({ defaultHook: validationHook });
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
    // Index the session for full-text search (best-effort; no-ops when disabled).
    await ctx.meili
      .index(indexName(ctx.config, SESSIONS_INDEX_KEY), [toSessionSearchDoc(doc)])
      .catch(() => {});
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
    // Index the parsed turns for full-text content search (best-effort; content
    // chunks only — byte-range-only chunks yield no turn docs).
    const turnDocs = docs.flatMap((d: any) => toTurnSearchDocs(d));
    await ctx.meili.index(indexName(ctx.config, TURNS_INDEX_KEY), turnDocs).catch(() => {});
    return c.json({ ok: true, inserted });
  });

  // Transcript bytes live in S3 only (ADR 0014), under <id>/transcript.jsonl.
  route.openapi(transcriptRoute, async (c: any) => {
    const id = c.req.param("id");
    const text = await c.req.text();
    if (!text?.trim()) return c.json({ error: "Empty transcript body" }, 400);
    const bucket = bucketName(ctx.config, "sessions");
    await ctx.blob.put(
      bucket,
      `${id}/transcript.jsonl`,
      new TextEncoder().encode(text),
      "application/x-ndjson",
    );
    return c.json({ ok: true, id, bytes: text.length });
  });

  route.openapi(resetRoute, async (c: any) => {
    const id = c.req.param("id");
    const db = ctx.couch.db("sessions");

    /** Every doc a `<design>/by_session` view emits for this session, with its rev. */
    const idsFrom = async (design: string): Promise<{ _id: string; _rev: string }[]> => {
      const res = await db.view(design, "by_session", {
        startkey: [id],
        endkey: [id, {}],
        reduce: false,
        include_docs: true,
      });
      return (res.rows as any[])
        .map((r) => r.doc)
        .filter((d) => d?._id && d?._rev)
        .map((d) => ({ _id: d._id, _rev: d._rev }));
    };

    const [events, chunks] = await Promise.all([idsFrom("events"), idsFrom("chunks")]);

    const summaryId = `summary:${id}`;
    let summary: { _id: string; _rev: string } | null = null;
    try {
      const doc = (await db.get(summaryId)) as { _id: string; _rev: string };
      summary = { _id: doc._id, _rev: doc._rev };
    } catch (err: any) {
      // A session with no summary (still running, or crashed before SessionEnd) is a
      // normal thing to reset — only a real failure should surface.
      if (err?.statusCode !== 404) throw err;
    }

    const doomed = [...events, ...chunks, ...(summary ? [summary] : [])];
    if (doomed.length) {
      await db.bulk({ docs: doomed.map((d) => ({ ...d, _deleted: true })) });
    }

    // Drop this session from search too. Re-ingest would overwrite the entries it
    // regenerates, but not the ones it no longer produces — turns from chunks that
    // stopped existing — and a fixture that deletes itself must not stay findable.
    // Best-effort: a disabled or unreachable engine leaves the index stale, and
    // `reindex` is still the backstop (ADR 0009).
    await Promise.allSettled([
      ctx.meili.deleteDocs(indexName(ctx.config, SESSIONS_INDEX_KEY), {
        ids: [searchDocId(id)],
      }),
      ctx.meili.deleteDocs(indexName(ctx.config, TURNS_INDEX_KEY), {
        filter: `sessionId = ${JSON.stringify(id)}`,
      }),
    ]);

    // The transcript blob is not derived, so it goes only when asked for.
    let blobs = 0;
    if (c.req.query("blobs") === "true") {
      try {
        await ctx.blob.remove(bucketName(ctx.config, "sessions"), `${id}/transcript.jsonl`);
        blobs = 1;
      } catch (err) {
        console.error(`[ingest] removing the transcript for ${id} failed (continuing):`, err);
      }
    }

    return c.json({
      ok: true,
      id,
      deleted: {
        summary: summary ? 1 : 0,
        events: events.length,
        chunks: chunks.length,
        blobs,
      },
    });
  });

  return app;
}

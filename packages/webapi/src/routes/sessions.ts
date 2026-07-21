import type { SessionAggregate, SessionStatus, SessionSummary } from "@claude-transcripts/shared";
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { bucketName } from "../config";
import type { AppContext } from "../context";

/** How recently a summary-less session must have had activity to count as
 *  `running` (vs `incomplete`/crashed). A heuristic — there is no live heartbeat. */
const RUNNING_WINDOW_MS = 15 * 60_000;

// ── Schemas ───────────────────────────────────────────────────────────────────

const ErrorSchema = z.object({ error: z.string() });

const TokenUsageSchema = z.object({
  input: z.number(),
  output: z.number(),
  cacheCreation: z.number(),
  cacheRead: z.number(),
  total: z.number(),
  messages: z.number(),
});

const SessionStatusSchema = z.enum(["ended", "running", "incomplete"]);

const SessionSummarySchema = z.object({
  sessionId: z.string(),
  timestamp: z.string(),
  startTimestamp: z.string().optional(),
  durationMs: z.number().optional(),
  model: z.string().optional(),
  cwd: z.string(),
  hostname: z.string(),
  eventCount: z.number(),
  promptCount: z.number(),
  errorCount: z.number(),
  toolCounts: z.record(z.string(), z.number()),
  endReason: z.string(),
  hasTranscript: z.boolean(),
  transcriptSize: z.number().optional(),
  status: SessionStatusSchema,
  lastActivity: z.string().optional(),
  tokenUsage: TokenUsageSchema.optional(),
  source: z.string().optional(),
});

const SessionsResponseSchema = z.object({
  sessions: z.array(SessionSummarySchema),
  totalCount: z.number(),
});

const TranscriptResponseSchema = z.object({
  messages: z.array(z.record(z.string(), z.any())),
  totalCount: z.number(),
  hasMore: z.boolean(),
});

// ── Mapping ───────────────────────────────────────────────────────────────────

/** Elapsed wall-clock between two ISO timestamps, or undefined if not derivable. */
function durationBetween(startIso?: string, endIso?: string): number | undefined {
  if (!startIso || !endIso) return undefined;
  const start = Date.parse(startIso);
  const end = Date.parse(endIso);
  if (Number.isNaN(start) || Number.isNaN(end) || end < start) return undefined;
  return end - start;
}

/**
 * Map a CouchDB `summary:` doc to the response contract. The summary doc records the
 * SessionEnd time (`timestamp`) but not the session start, so `firstTs` — the first
 * event's timestamp from the aggregate view — is threaded in to derive `durationMs`.
 */
function docToSummary(doc: any, firstTs?: string): SessionSummary {
  const bytes: number = doc.transcript_bytes ?? 0;
  return {
    sessionId: doc.session_id,
    timestamp: doc.timestamp,
    startTimestamp: firstTs || undefined,
    durationMs: durationBetween(firstTs, doc.timestamp),
    model: doc.model,
    cwd: doc.cwd ?? "",
    hostname: doc.hostname ?? "",
    eventCount: doc.event_count ?? 0,
    promptCount: doc.prompt_count ?? 0,
    errorCount: doc.error_count ?? 0,
    toolCounts: doc.tool_counts ?? {},
    endReason: doc.end_reason ?? "unknown",
    hasTranscript: bytes > 0,
    transcriptSize: bytes || undefined,
    status: "ended",
    source: doc.source || "live",
    tokenUsage: doc.token_usage,
  };
}

/**
 * Map a `session_index/aggregate` reduce row to the response contract. Ended
 * sessions carry their full rollup in `agg.summary` (fidelity equal to the summary
 * doc); summary-less sessions become `running` (recent activity) or `incomplete`
 * (stale — crashed before SessionEnd), with the counts accumulated live from events.
 */
function aggregateToSummary(
  sessionId: string,
  agg: SessionAggregate,
  nowMs: number,
): SessionSummary {
  if (agg.summary) {
    const s = agg.summary;
    const bytes = s.transcript_bytes ?? 0;
    return {
      sessionId,
      timestamp: s.timestamp || agg.last || "",
      startTimestamp: agg.first || undefined,
      durationMs: durationBetween(agg.first, s.timestamp || agg.last),
      model: agg.model || undefined,
      cwd: agg.cwd ?? "",
      hostname: agg.hostname ?? "",
      eventCount: s.event_count ?? 0,
      promptCount: s.prompt_count ?? 0,
      errorCount: s.error_count ?? 0,
      toolCounts: s.tool_counts ?? {},
      endReason: s.end_reason || "unknown",
      hasTranscript: bytes > 0,
      transcriptSize: bytes || undefined,
      status: "ended",
      lastActivity: agg.last || undefined,
      source: s.source || "live",
      tokenUsage: (s.token_usage as SessionSummary["tokenUsage"]) ?? undefined,
    };
  }

  const last = agg.last || agg.first || "";
  const lastMs = last ? Date.parse(last) : Number.NaN;
  const stale = Number.isNaN(lastMs) || nowMs - lastMs > RUNNING_WINDOW_MS;
  const status: SessionStatus = stale ? "incomplete" : "running";
  return {
    sessionId,
    timestamp: agg.first || agg.last || "",
    startTimestamp: agg.first || undefined,
    durationMs: durationBetween(agg.first, agg.last),
    model: agg.model || undefined,
    cwd: agg.cwd ?? "",
    hostname: agg.hostname ?? "",
    eventCount: agg.events ?? 0,
    promptCount: agg.prompts ?? 0,
    errorCount: agg.errors ?? 0,
    toolCounts: agg.tools ?? {},
    endReason: status,
    hasTranscript: false,
    status,
    lastActivity: agg.last || undefined,
    // No summary doc yet ⇒ still live/in-flight (a backfill writes its summary
    // atomically, so a summary-less session is always a live recording).
    source: "live",
  };
}

/** Best-effort recency key for ordering (running/incomplete float up by activity). */
function orderKey(s: SessionSummary): string {
  return s.lastActivity || s.timestamp || "";
}

/** A session_index row worth showing: ended, or a real started/active session. */
function isRealSession(agg: SessionAggregate | undefined): agg is SessionAggregate {
  return (
    Boolean(agg) && ((agg?.ended ?? 0) > 0 || (agg?.started ?? 0) > 0 || (agg?.events ?? 0) > 0)
  );
}

// ── Routes ────────────────────────────────────────────────────────────────────

const listRoute = createRoute({
  method: "get",
  path: "/sessions",
  operationId: "listSessions",
  request: {
    query: z.object({
      limit: z.string().optional(),
      skip: z.string().optional(),
    }),
  },
  responses: {
    200: {
      content: { "application/json": { schema: SessionsResponseSchema } },
      description: "Sessions",
    },
    500: { content: { "application/json": { schema: ErrorSchema } }, description: "Error" },
  },
});

const detailRoute = createRoute({
  method: "get",
  path: "/sessions/{id}",
  operationId: "getSession",
  request: { params: z.object({ id: z.string() }) },
  responses: {
    200: {
      content: { "application/json": { schema: SessionSummarySchema } },
      description: "Session",
    },
    404: { content: { "application/json": { schema: ErrorSchema } }, description: "Not found" },
  },
});

const transcriptRoute = createRoute({
  method: "get",
  path: "/sessions/{id}/transcript",
  operationId: "getSessionTranscript",
  request: {
    params: z.object({ id: z.string() }),
    query: z.object({ limit: z.string().optional(), offset: z.string().optional() }),
  },
  responses: {
    200: {
      content: { "application/json": { schema: TranscriptResponseSchema } },
      description: "Transcript",
    },
    404: { content: { "application/json": { schema: ErrorSchema } }, description: "Not found" },
  },
});

export function sessionRoutes(ctx: AppContext) {
  // Loosely typed so CouchDB's `any` docs don't fight the OpenAPI return types.
  const app = new OpenAPIHono();
  const route = app as unknown as {
    openapi: (r: unknown, h: (c: any) => unknown) => void;
  };

  route.openapi(listRoute, async (c: any) => {
    const limit = Number(c.req.query("limit") ?? 50);
    const skip = Number(c.req.query("skip") ?? 0);
    const db = ctx.couch.db("sessions");
    // One aggregate row per session (ended + running + incomplete), grouped by
    // session_id. Sorted + paginated in-memory — fine at Tier-1 volumes; a
    // time-keyed view is the Tier-2 move if the corpus outgrows it.
    const res = await db.view("session_index", "aggregate", { group: true, reduce: true });
    const now = Date.now();
    const all: SessionSummary[] = res.rows
      .filter((r: any) => isRealSession(r.value))
      .map((r: any) => aggregateToSummary(String(r.key), r.value, now));
    all.sort((a, b) => orderKey(b).localeCompare(orderKey(a)));
    const page = all.slice(skip, skip + limit);
    return c.json({ sessions: page, totalCount: all.length });
  });

  route.openapi(detailRoute, async (c: any) => {
    const id = c.req.param("id");
    const db = ctx.couch.db("sessions");
    // The aggregate row gives us the session's first-event timestamp (the summary
    // doc doesn't record a start), which docToSummary needs to derive duration.
    const res = await db.view("session_index", "aggregate", { group: true, reduce: true, key: id });
    const row: any = res.rows[0];
    const agg: SessionAggregate | undefined = isRealSession(row?.value) ? row.value : undefined;
    // Ended sessions: read the summary doc directly (full fidelity), enriched with
    // the aggregate's start time for duration.
    try {
      const doc = await db.get(`summary:${id}`);
      return c.json(docToSummary(doc, agg?.first));
    } catch {
      // Not ended — fall back to the live aggregate (running / incomplete).
    }
    if (!agg) return c.json({ error: "Session not found" }, 404);
    return c.json(aggregateToSummary(id, agg, Date.now()));
  });

  route.openapi(transcriptRoute, async (c: any) => {
    const id = c.req.param("id");
    const limit = Number(c.req.query("limit") ?? 100);
    const offset = Number(c.req.query("offset") ?? 0);
    const bucket = bucketName(ctx.config, "sessions");
    const stat = await ctx.blob.stat(bucket, `${id}/transcript.jsonl`);
    if (!stat) return c.json({ error: "No transcript stored" }, 404);
    const stream = await ctx.blob.get(bucket, `${id}/transcript.jsonl`);
    const text = await new Response(stream).text();
    const lines = text.split("\n").filter((l) => l.trim().length > 0);
    const page = lines.slice(offset, offset + limit).map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return { raw: l };
      }
    });
    return c.json({
      messages: page,
      totalCount: lines.length,
      hasMore: offset + limit < lines.length,
    });
  });

  return app;
}

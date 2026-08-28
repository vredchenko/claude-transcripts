import {
  buildChunkEntries,
  type SessionAggregate,
  type SessionStatus,
  type SessionSummary,
} from "@claude-transcripts/shared";
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { bucketName, idleThresholdMs, liveWindowMs } from "../config";
import type { AppContext } from "../context";
import {
  type ActiveDurationCache,
  activeDurations,
  createActiveDurationCache,
} from "../storage/active-duration";
import { validationHook } from "./validation";

// ── Schemas ───────────────────────────────────────────────────────────────────
//
// Every schema a consumer sees is registered as a **named component** via
// `.openapi("Name")`. That name is the one thing the generated clients inherit: without
// it the spec inlines each schema at its use site and orval has nothing to call the
// type but the route it appeared in — `ListSessions200SessionsItemStatus` rather than
// `SessionStatus`. Since the generated clients are the contract consumers actually read
// ([ADR 0019](../../../../docs/design/decisions/0019-openapi-source-of-truth-generated-clients.md)),
// naming here is what makes generation usable rather than something to hand-write around.

const ErrorSchema = z.object({ error: z.string() }).openapi("ApiError");

const TokenUsageSchema = z
  .object({
    input: z.number(),
    output: z.number(),
    cacheCreation: z.number(),
    cacheRead: z.number(),
    total: z.number(),
    messages: z.number(),
  })
  .openapi("TokenUsage");

const SessionStatusSchema = z.enum(["ended", "running", "incomplete"]).openapi("SessionStatus");

const SessionSummarySchema = z
  .object({
    sessionId: z.string(),
    timestamp: z.string(),
    startTimestamp: z.string().optional(),
    durationMs: z.number().optional(),
    activeMs: z.number().optional(),
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
  })
  .openapi("SessionSummary");

const SessionsResponseSchema = z
  .object({
    sessions: z.array(SessionSummarySchema),
    totalCount: z.number(),
  })
  .openapi("SessionsResponse");

const SpeakerRoleSchema = z
  .enum(["user", "assistant", "tool_result", "system", "other"])
  .openapi("SpeakerRole");

/** A tool invocation referenced from a turn. Shared by transcript entries and turns. */
const ToolUseSchema = z
  .object({ name: z.string(), id: z.string().optional() })
  .openapi("ToolUseRef");

/**
 * One turn of a transcript — the pruned `ChunkEntry` projection (ADR 0027), which is
 * what a `chunk` doc stores. Both transcript sources carry the same *fields*, so a
 * reader doesn't branch on `source`; they differ only in how they spell an absent
 * optional (see the note on `toolUses`). Raw, byte-exact JSONL is still reachable
 * through the read-only S3 proxy for consumers that need it.
 */
const TranscriptEntrySchema = z
  .object({
    role: SpeakerRoleSchema,
    timestamp: z.string().optional(),
    text: z.string().optional(),
    // Nullable because the two sources genuinely differ, and the spec has to admit it:
    // the `chunks/entries_by_session` view emits `toolUses: e.toolUses || null`, while
    // the S3 path runs `buildChunkEntries` and omits the field instead. Absent and null
    // mean the same thing to a reader, so this is a wart rather than a bug — but
    // declaring only one of them would misdescribe half the responses. Converging the
    // two (a view migration) is tracked in the roadmap.
    toolUses: z.array(ToolUseSchema).nullable().optional(),
    toolUseId: z.string().nullable().optional(),
    isError: z.boolean().optional(),
    isSidechain: z.boolean().optional(),
    /**
     * For a line that isn't a conversation turn, what it actually was —
     * `attachment:hook_success`, `file-history-snapshot`, `system:turn_duration`.
     * Absent on real turns, where `role` already says everything. Nullable because the
     * chunks view emits `null` for entries written before this existed.
     */
    kind: z.string().nullable().optional(),
  })
  .openapi("TranscriptEntry");

const TranscriptResponseSchema = z
  .object({
    entries: z.array(TranscriptEntrySchema),
    totalCount: z.number(),
    hasMore: z.boolean(),
    /** Which store served this page — `chunks` (CouchDB) or `s3`. */
    source: z.enum(["chunks", "s3"]).openapi("TranscriptSource"),
    /** How many transcript bytes the serving source covers (diagnostics). */
    byteCoverage: z.number(),
  })
  .openapi("TranscriptResponse");

const SpeakerTurnSchema = z
  .object({
    role: SpeakerRoleSchema,
    timestamp: z.string(),
    text: z.string(),
    toolUses: z.array(ToolUseSchema).nullable().optional(),
    toolUseId: z.string().nullable().optional(),
    isError: z.boolean().optional(),
  })
  .openapi("SpeakerTurn");

const TurnsResponseSchema = z
  .object({
    turns: z.array(SpeakerTurnSchema),
    totalCount: z.number(),
    hasMore: z.boolean(),
    role: SpeakerRoleSchema.nullable(),
  })
  .openapi("SessionTurnsResponse");

// A turn from the CROSS-session view (`by_role_time`) — carries its session/project
// context so turns stay attributable when read across all sessions.
const CrossSessionTurnSchema = z
  .object({
    sessionId: z.string(),
    cwd: z.string(),
    role: SpeakerRoleSchema,
    timestamp: z.string(),
    text: z.string(),
  })
  .openapi("CrossSessionTurn");

const CrossSessionTurnsResponseSchema = z
  .object({
    turns: z.array(CrossSessionTurnSchema),
    hasMore: z.boolean(),
    role: SpeakerRoleSchema.nullable(),
  })
  .openapi("CrossSessionTurnsResponse");

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
 * `chunkEntries` comes from the same aggregate row: a transcript is readable if
 * *either* store holds it, so a summary that recorded no bytes doesn't mask chunks.
 */
function docToSummary(doc: any, firstTs?: string, chunkEntries = 0): SessionSummary {
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
    hasTranscript: bytes > 0 || chunkEntries > 0,
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
  windowMs: number,
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
      hasTranscript: bytes > 0 || (agg.chunkEntries ?? 0) > 0,
      transcriptSize: bytes || undefined,
      status: "ended",
      lastActivity: agg.last || undefined,
      source: s.source || "live",
      tokenUsage: (s.token_usage as SessionSummary["tokenUsage"]) ?? undefined,
    };
  }

  const last = agg.last || agg.first || "";
  const lastMs = last ? Date.parse(last) : Number.NaN;
  const stale = Number.isNaN(lastMs) || nowMs - lastMs > windowMs;
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
    // Mid-flight chunks make the transcript readable long before the summary doc
    // lands, so a running (or crashed) session still reports one.
    hasTranscript: (agg.chunkEntries ?? 0) > 0,
    transcriptSize: agg.chunkBytes || undefined,
    status,
    lastActivity: agg.last || undefined,
    // No summary doc yet ⇒ still live/in-flight (a backfill writes its summary
    // atomically, so a summary-less session is always a live recording).
    source: "live",
  };
}

/** The S3 object key holding a session's byte-exact transcript. */
function blobKey(id: string): string {
  return `${id}/transcript.jsonl`;
}

/**
 * How much of a session's transcript the chunk docs can serve: `entries` is the turn
 * count from `chunks/entries_by_session` (0 for byte-range-only chunks — they carry no
 * `entries[]`), `bytes` is how far the chunks' byte ranges reach. Degrades to zero
 * coverage if the views aren't indexed yet, so the reader falls back to S3 rather than
 * failing.
 */
async function chunkCoverage(db: any, id: string): Promise<{ entries: number; bytes: number }> {
  try {
    const [count, furthest] = await Promise.all([
      db.view("chunks", "entries_by_session", { startkey: [id], endkey: [id, {}], reduce: true }),
      // Highest byte_end for the session: `by_session` is keyed [id, byte_start], read
      // backwards. `descending` swaps the bounds, so start high and end low.
      db.view("chunks", "by_session", {
        startkey: [id, {}],
        endkey: [id],
        descending: true,
        limit: 1,
      }),
    ]);
    return {
      entries: Number((count.rows as any[])[0]?.value ?? 0),
      bytes: Number((furthest.rows as any[])[0]?.value?.byte_end ?? 0),
    };
  } catch {
    return { entries: 0, bytes: 0 };
  }
}

/** Whether a session's S3 transcript exists; false if S3 is off or unreachable. */
async function blobTranscriptExists(ctx: AppContext, id: string): Promise<boolean> {
  try {
    return (await ctx.blob.stat(bucketName(ctx.config, "sessions"), blobKey(id))) !== null;
  } catch {
    return false;
  }
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

/**
 * Does a session overlap the `[from, to]` window? Absent or unparseable bounds are
 * treated as open, so a malformed date widens the result set rather than emptying it —
 * a caller seeing everything can tell something is wrong; one seeing nothing can't
 * distinguish that from a quiet month.
 *
 * A session's extent runs from its first event to its last. `timestamp` is the later
 * end (the summary's time, or the newest event for a live one) and `startTimestamp`
 * the earlier, so overlap is "ends after `from` and starts before `to`".
 */
/** Exact directory match, tolerant of a trailing slash on either side. */
function sameDir(a: string, b: string): boolean {
  return a.replace(/\/+$/, "") === b.replace(/\/+$/, "");
}

function overlapsRange(
  session: SessionSummary,
  from: string | undefined,
  to: string | undefined,
): boolean {
  const fromMs = from ? Date.parse(from) : Number.NaN;
  const toMs = to ? Date.parse(to) : Number.NaN;
  const startMs = Date.parse(session.startTimestamp ?? session.timestamp);
  const endMs = Date.parse(session.lastActivity ?? session.timestamp);

  if (!Number.isNaN(fromMs) && !Number.isNaN(endMs) && endMs < fromMs) return false;
  if (!Number.isNaN(toMs) && !Number.isNaN(startMs) && startMs > toMs) return false;
  return true;
}

// ── Routes ────────────────────────────────────────────────────────────────────

const listRoute = createRoute({
  method: "get",
  path: "/sessions",
  operationId: "listSessions",
  request: {
    query: z.object({
      limit: z.coerce.number().int().nonnegative().optional(),
      skip: z.coerce.number().int().nonnegative().optional(),
      /**
       * Narrow to sessions **overlapping** an ISO instant range — what a calendar or
       * timeline needs to draw one month without pulling the whole corpus.
       *
       * Overlap, not containment: a session that ran across the start of the window
       * belongs in it, and asking for a month must not drop the four-day session that
       * began the previous week. Either bound may be given alone.
       */
      from: z.string().optional(),
      to: z.string().optional(),
      /**
       * Narrow to one project directory / one host — exact match. What the recall
       * primer asks at session start ("how many sessions does this cwd have?"), and
       * what a "this project only" view needs without pulling the corpus.
       */
      cwd: z.string().optional(),
      hostname: z.string().optional(),
    }),
  },
  responses: {
    400: {
      content: { "application/json": { schema: ErrorSchema } },
      description: "Invalid request",
    },
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
    400: {
      content: { "application/json": { schema: ErrorSchema } },
      description: "Invalid request",
    },
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
    query: z.object({
      limit: z.coerce.number().int().nonnegative().optional(),
      offset: z.coerce.number().int().nonnegative().optional(),
    }),
  },
  responses: {
    400: {
      content: { "application/json": { schema: ErrorSchema } },
      description: "Invalid request",
    },
    200: {
      content: { "application/json": { schema: TranscriptResponseSchema } },
      description: "Transcript",
    },
    404: { content: { "application/json": { schema: ErrorSchema } }, description: "Not found" },
    502: {
      content: { "application/json": { schema: ErrorSchema } },
      description: "No transcript in CouchDB and the S3 fallback failed",
    },
  },
});

const turnsRoute = createRoute({
  method: "get",
  path: "/sessions/{id}/turns",
  operationId: "getSessionTurns",
  request: {
    params: z.object({ id: z.string() }),
    query: z.object({
      role: SpeakerRoleSchema.optional(),
      limit: z.coerce.number().int().nonnegative().optional(),
      offset: z.coerce.number().int().nonnegative().optional(),
    }),
  },
  responses: {
    400: {
      content: { "application/json": { schema: ErrorSchema } },
      description: "Invalid request",
    },
    200: {
      content: { "application/json": { schema: TurnsResponseSchema } },
      description: "Turns (speaker-split)",
    },
    404: { content: { "application/json": { schema: ErrorSchema } }, description: "Not found" },
  },
});

const crossTurnsRoute = createRoute({
  method: "get",
  path: "/turns",
  operationId: "getTurns",
  request: {
    query: z.object({
      role: SpeakerRoleSchema.optional(),
      from: z.string().optional(),
      to: z.string().optional(),
      limit: z.coerce.number().int().nonnegative().optional(),
      skip: z.coerce.number().int().nonnegative().optional(),
    }),
  },
  responses: {
    400: {
      content: { "application/json": { schema: ErrorSchema } },
      description: "Invalid request",
    },
    200: {
      content: { "application/json": { schema: CrossSessionTurnsResponseSchema } },
      description: "Cross-session turns (time-ordered)",
    },
    500: { content: { "application/json": { schema: ErrorSchema } }, description: "Error" },
  },
});

/**
 * Attach `activeMs` to whichever of these sessions has one.
 *
 * `orderKey` is the session's newest known timestamp, which is exactly the handle the
 * memo needs: append-only docs mean an ended session's answer never changes, and a
 * running one recomputes as its activity moves.
 */
async function withActiveDurations(
  sessions: SessionSummary[],
  ctx: AppContext,
  db: any,
  cache: ActiveDurationCache,
): Promise<SessionSummary[]> {
  const active = await activeDurations(
    db,
    sessions.map((s) => ({ sessionId: s.sessionId, through: orderKey(s) })),
    idleThresholdMs(ctx.config),
    cache,
  );
  return sessions.map((s) => {
    const ms = active.get(s.sessionId);
    return ms === undefined ? s : { ...s, activeMs: ms };
  });
}

export function sessionRoutes(ctx: AppContext) {
  // Loosely typed so CouchDB's `any` docs don't fight the OpenAPI return types.
  const app = new OpenAPIHono({ defaultHook: validationHook });
  // Per app, not per process: two webapis in one process (or two tests) must not share
  // a memo, and nothing here needs them to.
  const activeCache = createActiveDurationCache();
  const route = app as unknown as {
    openapi: (r: unknown, h: (c: any) => unknown) => void;
  };

  route.openapi(listRoute, async (c: any) => {
    const limit = Number(c.req.query("limit") ?? 50);
    const skip = Number(c.req.query("skip") ?? 0);
    const from = c.req.query("from");
    const to = c.req.query("to");
    const cwd = c.req.query("cwd");
    const hostname = c.req.query("hostname");
    const db = ctx.couch.db("sessions");
    // One aggregate row per session (ended + running + incomplete), grouped by
    // session_id. Sorted + paginated in-memory — fine at Tier-1 volumes; a
    // time-keyed view is the Tier-2 move if the corpus outgrows it.
    const res = await db.view("session_index", "aggregate", { group: true, reduce: true });
    const now = Date.now();
    const windowMs = liveWindowMs(ctx.config);
    const all: SessionSummary[] = res.rows
      .filter((r: any) => isRealSession(r.value))
      .map((r: any) => aggregateToSummary(String(r.key), r.value, now, windowMs));
    const windowed = all.filter(
      (s) =>
        overlapsRange(s, from, to) &&
        (!cwd || sameDir(s.cwd, cwd)) &&
        (!hostname || s.hostname === hostname),
    );
    windowed.sort((a, b) => orderKey(b).localeCompare(orderKey(a)));
    const page = windowed.slice(skip, skip + limit);
    // Active time for the page only, and cached per session: the split between working
    // and idle time is what separates "ran for four days" from "worked for two hours",
    // and every projection of this list shows it. Costs one extra view request per 100
    // rows, and nothing at all once a page has been read.
    const sessions = await withActiveDurations(page, ctx, db, activeCache);
    // Total is of the *filtered* set, so a paged client asking for one month doesn't
    // page against the size of the whole corpus.
    return c.json({ sessions, totalCount: windowed.length });
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
    let summary: SessionSummary;
    try {
      const doc = await db.get(`summary:${id}`);
      summary = docToSummary(doc, agg?.first, agg?.chunkEntries ?? 0);
    } catch {
      // Not ended — fall back to the live aggregate (running / incomplete).
      if (!agg) return c.json({ error: "Session not found" }, 404);
      summary = aggregateToSummary(id, agg, Date.now(), liveWindowMs(ctx.config));
    }
    // Neither the summary nor the chunks claim a transcript — but byte-range-only
    // chunks (`couchFullContentChunks` off) leave S3 as the only readable copy, so
    // confirm with a stat rather than reporting none. Worth one HEAD on the detail
    // view; the list can't afford it per row, so it reports from the index alone.
    if (!summary.hasTranscript) {
      summary.hasTranscript = await blobTranscriptExists(ctx, id);
    }
    // Active (working) time needs every event's timestamp, not just first/last.
    const [enriched] = await withActiveDurations([summary], ctx, db, activeCache);
    return c.json(enriched ?? summary);
  });

  /**
   * Transcript, served from the **chunk docs** by default and from the S3 blob only
   * when that reaches further.
   *
   * Chunks are flushed mid-session, so this reads a live session's transcript-so-far
   * — it no longer depends on the SessionEnd upload having happened. The S3 blob is
   * written once, at SessionEnd, so it exists only for a session that ended cleanly.
   *
   * Source choice is "whichever covers more bytes, chunks winning ties": identical for
   * an ended or backfilled session (both derive from the same file), chunks for a live
   * one (no blob yet), and S3 when a session's final flush was missed — e.g. the
   * forced SessionEnd flush lost the chunk-state lock to a concurrent Stop flush, so
   * the last chunk is short of the uploaded file.
   */
  route.openapi(transcriptRoute, async (c: any) => {
    const id = c.req.param("id");
    const limit = Number(c.req.query("limit") ?? 100);
    const offset = Number(c.req.query("offset") ?? 0);
    const db = ctx.couch.db("sessions");

    const chunks = await chunkCoverage(db, id);
    // A missing blob and an unreachable one both mean "can't serve from S3", but only
    // the latter is worth reporting — and only if CouchDB can't serve either.
    let blob: { size: number } | null = null;
    let blobError: string | undefined;
    try {
      blob = await ctx.blob.stat(bucketName(ctx.config, "sessions"), blobKey(id));
    } catch (err) {
      blobError = err instanceof Error ? err.message : String(err);
    }

    if (chunks.entries > 0 && (!blob || chunks.bytes >= blob.size)) {
      // Page at the view — CouchDB does the slicing, so a long transcript never has
      // to be materialised in the gateway.
      const res = await db.view("chunks", "entries_by_session", {
        startkey: [id],
        endkey: [id, {}],
        reduce: false,
        limit,
        skip: offset,
      });
      const page = (res.rows as any[]).map((r) => r.value);
      return c.json({
        entries: page,
        totalCount: chunks.entries,
        hasMore: offset + page.length < chunks.entries,
        source: "chunks",
        byteCoverage: chunks.bytes,
      });
    }

    if (blob) {
      // Normalise the raw JSONL to the same turn shape the chunk view emits, so the
      // response is source-independent. `buildChunkEntries` is the exact projection
      // the writer applies before embedding entries in a chunk doc.
      const stream = await ctx.blob.get(bucketName(ctx.config, "sessions"), blobKey(id));
      const entries = buildChunkEntries(await new Response(stream).text());
      const page = entries.slice(offset, offset + limit);
      return c.json({
        entries: page,
        totalCount: entries.length,
        hasMore: offset + page.length < entries.length,
        source: "s3",
        byteCoverage: blob.size,
      });
    }

    if (blobError) {
      return c.json({ error: `No transcript in CouchDB, and S3 failed: ${blobError}` }, 502);
    }
    return c.json({ error: "No transcript stored" }, 404);
  });

  // Speaker-split: one side of the conversation (or all turns) from the
  // `speaker_split/by_role` view over full-content chunks. Populated only for
  // sessions logged with `couchFullContentChunks` on; empty otherwise.
  route.openapi(turnsRoute, async (c: any) => {
    const id = c.req.param("id");
    const role: string | undefined = c.req.query("role");
    const limit = Number(c.req.query("limit") ?? 500);
    const offset = Number(c.req.query("offset") ?? 0);
    const db = ctx.couch.db("sessions");
    // Key prefix: [id] for all turns, [id, role] for one speaker. `{}` is CouchDB's
    // high-key sentinel, so endkey collects everything under the prefix.
    const startkey = role ? [id, role] : [id];
    const endkey = role ? [id, role, {}] : [id, {}];
    const res = await db.view("speaker_split", "by_role", {
      startkey,
      endkey,
      reduce: false,
    });
    const all = res.rows.map((r: any) => r.value);
    const page = all.slice(offset, offset + limit);
    return c.json({
      turns: page,
      totalCount: all.length,
      hasMore: offset + limit < all.length,
      role: role ?? null,
    });
  });

  // Cross-session: every turn of one speaker across ALL sessions, in time order,
  // from `speaker_split/by_role_time`. The corpus for "what do I repeatedly say /
  // what does Claude repeatedly say" analysis. Paginated at the view (limit/skip)
  // since it spans the whole store; optional from/to ISO-timestamp bounds.
  route.openapi(crossTurnsRoute, async (c: any) => {
    const role: string | undefined = c.req.query("role");
    const from: string | undefined = c.req.query("from");
    const to: string | undefined = c.req.query("to");
    const limit = Number(c.req.query("limit") ?? 200);
    const skip = Number(c.req.query("skip") ?? 0);
    const db = ctx.couch.db("sessions");
    // Fetch limit+1 to detect a further page without a separate count query.
    const opts: Record<string, unknown> = { reduce: false, limit: limit + 1, skip };
    if (role) {
      opts.startkey = [role, from ?? ""];
      opts.endkey = [role, to ?? {}];
    }
    const res = await db.view("speaker_split", "by_role_time", opts);
    const rows = res.rows.map((r: any) => r.value);
    const hasMore = rows.length > limit;
    return c.json({
      turns: hasMore ? rows.slice(0, limit) : rows,
      hasMore,
      role: role ?? null,
    });
  });

  return app;
}

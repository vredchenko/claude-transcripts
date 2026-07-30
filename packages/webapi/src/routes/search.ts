import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import type { AppContext } from "../context";
import {
  type IndexSettings,
  SESSIONS_INDEX,
  SESSIONS_INDEX_SETTINGS,
  TURNS_INDEX,
  TURNS_INDEX_SETTINGS,
  toSessionSearchDoc,
  toTurnSearchDocs,
} from "../storage/meili";

const ErrorSchema = z.object({ error: z.string() });

/** Documents per Meilisearch request — keeps a big rebuild off one huge payload. */
const BATCH = 1000;

/**
 * Clear an index and re-add `docs` in batches, waiting for Meilisearch's async
 * validation so the caller learns what actually landed.
 */
async function rebuild(
  ctx: AppContext,
  uid: string,
  settings: IndexSettings,
  docs: Record<string, unknown>[],
): Promise<{ indexed: number; failures: string[] }> {
  await ctx.meili.ensureIndex(uid, settings);
  const tasks: number[] = [];
  const cleared = await ctx.meili.clear(uid);
  if (cleared !== null) tasks.push(cleared);
  for (let i = 0; i < docs.length; i += BATCH) {
    const task = await ctx.meili.index(uid, docs.slice(i, i + BATCH));
    if (task !== null) tasks.push(task);
  }
  return ctx.meili.taskFailures(tasks);
}

const SearchHitSchema = z
  .object({
    sessionId: z.string(),
    timestamp: z.string().optional(),
    cwd: z.string().optional(),
    model: z.string().optional(),
    hostname: z.string().optional(),
    endReason: z.string().optional(),
    source: z.string().optional(),
    tools: z.array(z.string()).optional(),
  })
  .passthrough();

/** A conversation-content match — one turn, with a cropped snippet around the hit. */
const TurnHitSchema = z.object({
  sessionId: z.string(),
  role: z.string(),
  snippet: z.string(),
  timestamp: z.string().optional(),
  cwd: z.string().optional(),
});

const SearchResponseSchema = z.object({
  /** Session-metadata matches (cwd/model/tools/host). */
  hits: z.array(SearchHitSchema),
  /** Conversation-content matches (turn text; content chunks only). */
  turns: z.array(TurnHitSchema),
  query: z.string(),
  /** false when Meilisearch is disabled/unconfigured — the UI can say so. */
  enabled: z.boolean(),
});

const ReindexResultSchema = z.object({
  enabled: z.boolean(),
  sessions: z.object({ scanned: z.number(), indexed: z.number() }),
  turns: z.object({ scanned: z.number(), indexed: z.number() }),
  /** Distinct Meilisearch task errors, if any — empty on a clean rebuild. */
  failures: z.array(z.string()),
});

const reindexRoute = createRoute({
  method: "post",
  path: "/search/reindex",
  operationId: "searchReindex",
  responses: {
    200: {
      content: { "application/json": { schema: ReindexResultSchema } },
      description: "Reindex result",
    },
    500: { content: { "application/json": { schema: ErrorSchema } }, description: "Error" },
  },
});

const searchRoute = createRoute({
  method: "get",
  path: "/search",
  operationId: "search",
  request: { query: z.object({ q: z.string().optional(), limit: z.string().optional() }) },
  responses: {
    200: {
      content: { "application/json": { schema: SearchResponseSchema } },
      description: "Search results",
    },
    500: { content: { "application/json": { schema: ErrorSchema } }, description: "Error" },
  },
});

/**
 * Full-text session search over Meilisearch (ADR 0009). Best-effort: returns an
 * empty result set (with `enabled: false`) when search is disabled or Meili is
 * unreachable, so the UI degrades gracefully rather than erroring.
 */
export function searchRoutes(ctx: AppContext) {
  const app = new OpenAPIHono();
  const route = app as unknown as {
    openapi: (r: unknown, h: (c: any) => unknown) => void;
  };

  route.openapi(searchRoute, async (c: any) => {
    const q = (c.req.query("q") ?? "").trim();
    const limit = Number(c.req.query("limit") ?? 20);
    if (!q) return c.json({ hits: [], turns: [], query: "", enabled: ctx.meili.enabled });
    const [hits, turnHits] = await Promise.all([
      ctx.meili.search(SESSIONS_INDEX, q, { limit }),
      ctx.meili.search(TURNS_INDEX, q, {
        limit,
        attributesToCrop: ["text"],
        cropLength: 40,
      }),
    ]);
    // Prefer Meili's cropped `_formatted.text` snippet; fall back to the raw text.
    const turns = turnHits.map((h: any) => ({
      sessionId: h.sessionId,
      role: h.role ?? "other",
      snippet: h._formatted?.text ?? h.text ?? "",
      timestamp: h.timestamp,
      cwd: h.cwd,
    }));
    return c.json({ hits, turns, query: q, enabled: ctx.meili.enabled });
  });

  /**
   * Rebuild both search indexes from CouchDB.
   *
   * The indexes are **derived** state, populated as a side effect of writes through
   * `/api/ingest/*`. Anything already in CouchDB — history adopted before search
   * existed, or written by a path that doesn't go through ingest — is therefore
   * invisible to search until it is rebuilt, and a document deleted from CouchDB stays
   * in the index. This is the one operation that makes the indexes match the store.
   *
   * It clears first, so it also drops stale entries; searches return nothing for the
   * (brief) window until the rebuild lands. Unlike the ingest hot path it *waits* for
   * Meilisearch's async validation and reports failures, rather than assuming a `202`
   * meant success.
   */
  route.openapi(reindexRoute, async (c: any) => {
    if (!ctx.meili.enabled) {
      return c.json({
        enabled: false,
        sessions: { scanned: 0, indexed: 0 },
        turns: { scanned: 0, indexed: 0 },
        failures: [],
      });
    }

    const db = ctx.couch.db("sessions");

    // Sessions: every `summary` doc, via the date view (reduce off so rows are docs).
    const summaries = await db.view("sessions", "by_date", { reduce: false, include_docs: true });
    const sessionDocs = (summaries.rows as any[])
      .map((r) => r.doc)
      .filter((d) => d?.type === "summary")
      .map((d) => toSessionSearchDoc(d));

    // Turns: every full-content `chunk` doc. Byte-range-only chunks project to nothing.
    const chunks = await db.view("chunks", "by_session", { include_docs: true });
    const turnDocs = (chunks.rows as any[])
      .map((r) => r.doc)
      .filter((d) => d?.type === "chunk")
      .flatMap((d) => toTurnSearchDocs(d));

    const [sessions, turns] = await Promise.all([
      rebuild(ctx, SESSIONS_INDEX, SESSIONS_INDEX_SETTINGS, sessionDocs),
      rebuild(ctx, TURNS_INDEX, TURNS_INDEX_SETTINGS, turnDocs),
    ]);

    return c.json({
      enabled: true,
      sessions: { scanned: sessionDocs.length, indexed: sessions.indexed },
      turns: { scanned: turnDocs.length, indexed: turns.indexed },
      failures: [...new Set([...sessions.failures, ...turns.failures])],
    });
  });

  return app;
}

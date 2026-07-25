import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import type { AppContext } from "../context";
import { SESSIONS_INDEX, TURNS_INDEX } from "../storage/meili";

const ErrorSchema = z.object({ error: z.string() });

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

  return app;
}

import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import type { AppContext } from "../context";
import { SESSIONS_INDEX } from "../storage/meili";

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

const SearchResponseSchema = z.object({
  hits: z.array(SearchHitSchema),
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
    if (!q) return c.json({ hits: [], query: "", enabled: ctx.meili.enabled });
    const hits = await ctx.meili.search(SESSIONS_INDEX, q, { limit });
    return c.json({ hits, query: q, enabled: ctx.meili.enabled });
  });

  return app;
}

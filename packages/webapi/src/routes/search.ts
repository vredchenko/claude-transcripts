import { HIGHLIGHT_PRE } from "@claude-transcripts/shared";
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { indexName } from "../config";
import type { AppContext } from "../context";
import {
  type IndexSettings,
  SESSIONS_INDEX_KEY,
  SESSIONS_INDEX_SETTINGS,
  TURNS_INDEX_KEY,
  TURNS_INDEX_SETTINGS,
  toRunningSessionSearchDoc,
  toSessionSearchDoc,
  toTurnSearchDocs,
} from "../storage/meili";
import { validationHook } from "./validation";

const ErrorSchema = z.object({ error: z.string() }).openapi("ApiError");

/** Documents per Meilisearch request — keeps a big rebuild off one huge payload. */
const BATCH = 1000;

/**
 * Words of context Meilisearch crops a snippet to, centred on the match.
 *
 * The original 40 gave a line so short that a match often arrived with no sentence
 * around it — you could see your word and not what was being said about it, which is
 * the whole reason to read a search result rather than just open the session. 90 is
 * roughly two lines at the width the results render at: enough to judge relevance,
 * short enough that a page of them is still scannable.
 */
const SNIPPET_WORDS = 90;

/**
 * Session-index attributes worth highlighting. These are exactly the searchable ones
 * minus `sessionId` — an id match highlights a hex string, which tells the reader
 * nothing they can't already see.
 */
const SESSION_HIGHLIGHT_ATTRS = ["cwd", "model", "hostname", "endReason", "tools"];

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

/**
 * Which of a session's fields the query actually hit, read back out of Meilisearch's
 * `_formatted` block by looking for the highlight marks it put there.
 *
 * `_formatted` carries every requested attribute whether or not it matched, so
 * presence proves nothing — only a mark does. `tools` is an array, so its values are
 * checked individually rather than stringified.
 */
function matchedAttributes(formatted: Record<string, unknown> | undefined): string[] {
  if (!formatted) return [];
  const marked = (value: unknown): boolean =>
    typeof value === "string"
      ? value.includes(HIGHLIGHT_PRE)
      : Array.isArray(value) && value.some(marked);
  return SESSION_HIGHLIGHT_ATTRS.filter((attr) => marked(formatted[attr]));
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
    promptCount: z.number().optional(),
    eventCount: z.number().optional(),
    /**
     * Which fields the query matched (`cwd`, `model`, `hostname`, `endReason`,
     * `tools`) — the answer to "why is this session in my results?", which a row of
     * metadata otherwise leaves the reader to guess at.
     */
    matchedIn: z.array(z.string()).optional(),
  })
  .passthrough()
  .openapi("SearchHit");

/**
 * A conversation-content match — one turn, with a cropped snippet around the hit.
 *
 * `snippet` carries highlight marks (`shared/src/highlight.ts`): private-use
 * delimiters around the matched spans, **not** markup. Render it with
 * `splitMarkedText`, or strip the marks with `stripHighlightMarks` for a plain-text
 * context. Rendering it as HTML would be a bug, and a security one.
 */
const TurnHitSchema = z
  .object({
    sessionId: z.string(),
    role: z.string(),
    snippet: z.string(),
    timestamp: z.string().optional(),
    cwd: z.string().optional(),
  })
  .openapi("TurnHit");

const SearchResponseSchema = z
  .object({
    /** Session-metadata matches (cwd/model/tools/host). */
    hits: z.array(SearchHitSchema),
    /** Conversation-content matches (turn text; content chunks only). */
    turns: z.array(TurnHitSchema),
    query: z.string(),
    /** false when Meilisearch is disabled/unconfigured — the UI can say so. */
    enabled: z.boolean(),
    /**
     * Approximate match counts per index, so a results page knows whether there's a
     * next page. Estimated by design — Meilisearch stops counting early on a large
     * corpus.
     */
    totals: z.object({ sessions: z.number(), turns: z.number() }).openapi("SearchTotals"),
    /**
     * The distinct values available to filter on, across the whole corpus rather than
     * the current page — otherwise the filter controls would shrink as you use them.
     */
    facets: z
      .object({
        cwd: z.array(z.string()),
        model: z.array(z.string()),
        hostname: z.array(z.string()),
        source: z.array(z.string()),
      })
      .openapi("SearchFacets"),
  })
  .openapi("SearchResponse");

const IndexCountsSchema = z
  .object({ scanned: z.number(), indexed: z.number() })
  .openapi("IndexCounts");

const ReindexResultSchema = z
  .object({
    enabled: z.boolean(),
    sessions: IndexCountsSchema,
    turns: IndexCountsSchema,
    /** Distinct Meilisearch task errors, if any — empty on a clean rebuild. */
    failures: z.array(z.string()),
  })
  .openapi("ReindexResult");

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
  request: {
    query: z.object({
      q: z.string().optional(),
      limit: z.coerce.number().int().nonnegative().optional(),
      offset: z.coerce.number().int().nonnegative().optional(),
      /** Narrow to one project directory / model / host / provenance. */
      cwd: z.string().optional(),
      model: z.string().optional(),
      hostname: z.string().optional(),
      source: z.string().optional(),
    }),
  },
  responses: {
    400: {
      content: { "application/json": { schema: ErrorSchema } },
      description: "Invalid request",
    },
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
  const app = new OpenAPIHono({ defaultHook: validationHook });
  const route = app as unknown as {
    openapi: (r: unknown, h: (c: any) => unknown) => void;
  };

  route.openapi(searchRoute, async (c: any) => {
    const q = (c.req.query("q") ?? "").trim();
    const limit = Number(c.req.query("limit") ?? 20);
    const offset = Number(c.req.query("offset") ?? 0);

    // Only `sessions` carries these attributes; the turns index has cwd alone. Filter
    // each index by what it actually holds rather than sending Meilisearch a filter on
    // a field it doesn't know, which is an error rather than an empty result.
    const eq = (attr: string, value?: string) =>
      value ? `${attr} = ${JSON.stringify(value)}` : null;
    const sessionFilter = [
      eq("cwd", c.req.query("cwd")),
      eq("model", c.req.query("model")),
      eq("hostname", c.req.query("hostname")),
      eq("source", c.req.query("source")),
    ].filter((f): f is string => f !== null);
    const turnFilter = [eq("cwd", c.req.query("cwd"))].filter((f): f is string => f !== null);

    if (!q) {
      return c.json({
        hits: [],
        turns: [],
        query: "",
        enabled: ctx.meili.enabled,
        totals: { sessions: 0, turns: 0 },
        facets: { cwd: [], model: [], hostname: [], source: [] },
      });
    }

    const [sessionRes, turnRes, facets] = await Promise.all([
      ctx.meili.search(indexName(ctx.config, SESSIONS_INDEX_KEY), q, {
        limit,
        offset,
        filter: sessionFilter,
        // Highlighted so the result can say *why* this session matched. A metadata
        // hit is otherwise indistinguishable from any other row in the list — the
        // query touched one of these fields, and the reader can't tell which.
        attributesToHighlight: SESSION_HIGHLIGHT_ATTRS,
      }),
      ctx.meili.search(indexName(ctx.config, TURNS_INDEX_KEY), q, {
        limit,
        offset,
        filter: turnFilter,
        attributesToCrop: ["text"],
        cropLength: SNIPPET_WORDS,
        attributesToHighlight: ["text"],
      }),
      // Facets describe the whole corpus, not this page — they're what the filter
      // controls offer, so they must not shrink as the user filters.
      ctx.meili.facets(indexName(ctx.config, SESSIONS_INDEX_KEY), [
        "cwd",
        "model",
        "hostname",
        "source",
      ]),
    ]);

    // Prefer Meili's cropped + marked `_formatted.text` snippet; fall back to the raw
    // text. The marks are private-use delimiters, not markup — see
    // `shared/src/highlight.ts` for why, and for the readers that turn them into spans.
    const turns = turnRes.hits.map((h: any) => ({
      sessionId: h.sessionId,
      role: h.role ?? "other",
      snippet: h._formatted?.text ?? h.text ?? "",
      timestamp: h.timestamp,
      cwd: h.cwd,
    }));

    // `_formatted` is Meilisearch's bookkeeping and would be noise in the response;
    // what a reader wants from it is the one fact it encodes — which fields matched.
    const hits = sessionRes.hits.map((h: any) => {
      const { _formatted, ...rest } = h;
      return { ...rest, matchedIn: matchedAttributes(_formatted) };
    });

    return c.json({
      hits,
      turns,
      query: q,
      enabled: ctx.meili.enabled,
      totals: { sessions: sessionRes.estimatedTotalHits, turns: turnRes.estimatedTotalHits },
      facets: {
        cwd: facets.cwd ?? [],
        model: facets.model ?? [],
        hostname: facets.hostname ?? [],
        source: facets.source ?? [],
      },
    });
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

    // …plus the ones with no summary yet — running, or crashed before SessionEnd.
    // Building the index from `summary` docs alone made a session findable only after
    // it ended, so the sessions you'd most want to search for were the missing ones.
    // The aggregate has a row per session either way; take the rows that carry no
    // summary, and leave the ended ones to the projection above.
    // Deliberately queried from CouchDB rather than read from `ctx.sessionIndex`,
    // even though the index holds exactly these rows: reindex is the reconciliation
    // path, the thing you run when you suspect a reader has drifted. Rebuilding one
    // cache from another would make it unable to detect the drift it exists to fix.
    const aggregate = await db.view("session_index", "aggregate", { group: true, reduce: true });
    for (const row of aggregate.rows as any[]) {
      const agg = row?.value;
      if (!agg || agg.summary) continue;
      // Guard against rows a stray doc could conjure: a real session has events.
      if (!(agg.events > 0)) continue;
      sessionDocs.push(toRunningSessionSearchDoc(String(row.key), agg));
    }

    // Turns: every full-content `chunk` doc. Byte-range-only chunks project to nothing.
    const chunks = await db.view("chunks", "by_session", { include_docs: true });
    const turnDocs = (chunks.rows as any[])
      .map((r) => r.doc)
      .filter((d) => d?.type === "chunk")
      .flatMap((d) => toTurnSearchDocs(d));

    const [sessions, turns] = await Promise.all([
      rebuild(ctx, indexName(ctx.config, SESSIONS_INDEX_KEY), SESSIONS_INDEX_SETTINGS, sessionDocs),
      rebuild(ctx, indexName(ctx.config, TURNS_INDEX_KEY), TURNS_INDEX_SETTINGS, turnDocs),
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

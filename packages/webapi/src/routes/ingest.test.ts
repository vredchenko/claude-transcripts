/**
 * `GET /api/ingest/{id}/high-water` — where a live writer resumes chunking (#288). The
 * hook used to ask CouchDB directly; it now asks here, so this answer is what keeps a
 * resumed session on its stored chunk boundaries instead of re-chunking from zero.
 */
import { describe, expect, test } from "bun:test";
import type { AppContext } from "../context";
import { ingestRoutes } from "./ingest";

/** A fake `chunks/by_session` view, keyed [session, byte_start], value carrying byte_end. */
function app(chunks: { session: string; start: number; end: number }[], fail = false) {
  const queries: Record<string, unknown>[] = [];
  const db = {
    async view(design: string, name: string, params: Record<string, any>) {
      expect(`${design}/${name}`).toBe("chunks/by_session");
      queries.push(params);
      if (fail) throw new Error("couch down");
      const [sid] = params.endkey as [string];
      const rows = chunks
        .filter((c) => c.session === sid)
        .sort((a, b) => (params.descending ? b.start - a.start : a.start - b.start))
        .slice(0, params.limit ?? Infinity)
        .map((c) => ({ key: [c.session, c.start], value: { byte_end: c.end } }));
      return { rows };
    },
  };
  const ctx = { couch: { db: () => db }, config: {} } as unknown as AppContext;
  return { routes: ingestRoutes(ctx), queries };
}

describe("GET /ingest/{id}/high-water", () => {
  test("is the byte_end of the session's furthest chunk", async () => {
    const { routes, queries } = app([
      { session: "s1", start: 0, end: 100 },
      { session: "s1", start: 100, end: 2_600 },
      { session: "s2", start: 0, end: 9_999 },
    ]);
    const res = await routes.request("/ingest/s1/high-water");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: "s1", bytes: 2_600 });
    // One row, read backwards: the query is bounded whatever the session's size.
    expect(queries[0]).toMatchObject({ descending: true, limit: 1 });
  });

  test("is 0 for a session with no chunks", async () => {
    const { routes } = app([{ session: "other", start: 0, end: 100 }]);
    expect(await (await routes.request("/ingest/s1/high-water")).json()).toEqual({
      id: "s1",
      bytes: 0,
    });
  });

  test("an unreachable store is an error, not a 0 that would restart chunking", async () => {
    const { routes } = app([], true);
    const res = await routes.request("/ingest/s1/high-water");
    expect(res.status).toBeGreaterThanOrEqual(500);
  });
});

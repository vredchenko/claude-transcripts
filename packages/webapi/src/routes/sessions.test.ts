import { describe, expect, test } from "bun:test";
import type { AppContext } from "../context";
import { sessionRoutes } from "./sessions";

type Key = unknown[];
type Row = { key: Key; value: unknown };

/** CouchDB collation, enough for these keys: numbers < strings < objects (`{}`). */
function rank(v: unknown): number {
  if (typeof v === "number") return 1;
  if (typeof v === "string") return 2;
  return 3;
}
function compareKeys(a: Key, b: Key): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const x = a[i];
    const y = b[i];
    const r = rank(x) - rank(y);
    if (r !== 0) return r;
    if (typeof x === "number" && typeof y === "number" && x !== y) return x - y;
    if (typeof x === "string" && typeof y === "string" && x !== y) return x < y ? -1 : 1;
  }
  return a.length - b.length;
}

function turn(role: string, i: number) {
  return { role, timestamp: `2026-03-18T09:00:0${i}.000Z`, text: `${role} ${i}` };
}

/** A fake `speaker_split/by_role` view (`_count` reduce) that records each query. */
function fakeCouch(rows: Row[]) {
  const sorted = [...rows].sort((a, b) => compareKeys(a.key, b.key));
  const calls: Record<string, any>[] = [];
  const db = {
    async view(design: string, name: string, params: Record<string, any>) {
      expect(`${design}/${name}`).toBe("speaker_split/by_role");
      calls.push(params);
      const inRange = sorted.filter(
        (r) => compareKeys(r.key, params.startkey) >= 0 && compareKeys(r.key, params.endkey) <= 0,
      );
      if (params.reduce)
        return { rows: inRange.length ? [{ key: null, value: inRange.length }] : [] };
      const skip = params.skip ?? 0;
      return { rows: inRange.slice(skip, skip + params.limit) };
    },
  };
  const ctx = { couch: { db: () => db } } as unknown as AppContext;
  return { app: sessionRoutes(ctx), calls };
}

const SID = "s-1";
// Interleaved in transcript order; the view groups them by role.
const CORPUS: Row[] = [
  { key: [SID, "user", 0, 0], value: turn("user", 0) },
  { key: [SID, "assistant", 100, 1], value: turn("assistant", 1) },
  { key: [SID, "user", 200, 2], value: turn("user", 2) },
  { key: [SID, "assistant", 300, 3], value: turn("assistant", 3) },
  { key: [SID, "assistant", 400, 4], value: turn("assistant", 4) },
  // Another session's turns must never leak into the range or the count.
  { key: ["s-2", "user", 0, 0], value: turn("user", 9) },
];

async function getTurns(app: { fetch: (r: Request) => Promise<Response> | Response }, qs = "") {
  const res = await app.fetch(new Request(`http://localhost/sessions/${SID}/turns${qs}`));
  expect(res.status).toBe(200);
  return (await res.json()) as any;
}

describe("GET /sessions/{id}/turns", () => {
  test("pages at the view and counts with the _count reduce", async () => {
    const { app, calls } = fakeCouch(CORPUS);
    const body = await getTurns(app, "?offset=1&limit=2");

    const page = calls.find((p) => p.reduce === false);
    expect(page).toEqual({
      startkey: [SID],
      endkey: [SID, {}],
      reduce: false,
      limit: 2,
      skip: 1,
    });
    const count = calls.find((p) => p.reduce === true);
    expect(count).toEqual({ startkey: [SID], endkey: [SID, {}], reduce: true });

    // View order: grouped by role (assistant < user), then byte order within a role.
    expect(body.turns.map((t: any) => t.text)).toEqual(["assistant 3", "assistant 4"]);
    expect(body.totalCount).toBe(5);
    expect(body.hasMore).toBe(true);
    expect(body.role).toBeNull();
  });

  test("defaults to offset 0 / limit 500 and reports no further page", async () => {
    const { app, calls } = fakeCouch(CORPUS);
    const body = await getTurns(app);
    const page = calls.find((p) => p.reduce === false);
    expect(page?.limit).toBe(500);
    expect(page?.skip).toBe(0);
    expect(body.turns.map((t: any) => t.text)).toEqual([
      "assistant 1",
      "assistant 3",
      "assistant 4",
      "user 0",
      "user 2",
    ]);
    expect(body.totalCount).toBe(5);
    expect(body.hasMore).toBe(false);
  });

  test("a role filter bounds both queries to [id, role]", async () => {
    const { app, calls } = fakeCouch(CORPUS);
    const body = await getTurns(app, "?role=user&limit=1");
    for (const p of calls) {
      expect(p.startkey).toEqual([SID, "user"]);
      expect(p.endkey).toEqual([SID, "user", {}]);
    }
    expect(body.turns.map((t: any) => t.text)).toEqual(["user 0"]);
    expect(body.totalCount).toBe(2);
    expect(body.hasMore).toBe(true);
    expect(body.role).toBe("user");
  });

  test("an offset past the end is an empty last page", async () => {
    const { app } = fakeCouch(CORPUS);
    const body = await getTurns(app, "?offset=9");
    expect(body).toMatchObject({ turns: [], totalCount: 5, hasMore: false });
  });

  test("a session with no turns is an empty page with a zero count", async () => {
    const { app } = fakeCouch([]);
    const body = await getTurns(app, "?role=assistant");
    expect(body).toEqual({ turns: [], totalCount: 0, hasMore: false, role: "assistant" });
  });
});

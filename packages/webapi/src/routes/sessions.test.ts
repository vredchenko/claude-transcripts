import { describe, expect, test } from "bun:test";
import type { AppContext } from "../context";
import { reconciledThenResumed, sessionRoutes, sessionStatus } from "./sessions";

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

  test("a session with no turns is an empty page with a zero count", async () => {
    const { app } = fakeCouch([]);
    const body = await getTurns(app, "?role=assistant");
    expect(body).toEqual({ turns: [], totalCount: 0, hasMore: false, role: "assistant" });
  });
});

describe("GET /sessions?status=", () => {
  const now = Date.now();
  const ago = (h: number) => new Date(now - h * 3600_000).toISOString();
  const agg = (last: string, summary: object | null = null) => ({
    ended: summary ? 1 : 0,
    events: 3,
    prompts: 1,
    errors: 0,
    started: 1,
    tools: {},
    first: last,
    last,
    model: "",
    cwd: "/p",
    hostname: "h",
    summary,
    chunkEntries: 0,
    chunkBytes: 0,
  });
  const rows = [
    { key: "ended", value: agg(ago(100), { event_count: 3, timestamp: ago(100) }) },
    { key: "running", value: agg(ago(1)) },
    { key: "incomplete", value: agg(ago(48)) },
  ];
  const reconciled = (at: number, last: number) => ({
    ...agg(ago(last), { event_count: 3, timestamp: ago(at), source: "reconcile" }),
    first: ago(at + 1),
  });
  const ctx = {
    couch: { db: () => ({ view: async () => ({ rows: [] }) }) },
    sessionIndex: { ready: true, rows: () => rows },
    config: { system: {} },
  } as unknown as AppContext;
  const app = sessionRoutes(ctx);

  test.each(["ended", "running", "incomplete"])("lists only the %s sessions", async (status) => {
    const res = await app.fetch(new Request(`http://localhost/sessions?status=${status}`));
    const body = (await res.json()) as any;
    expect(body.sessions.map((s: any) => s.sessionId)).toEqual([status]);
    expect(body.totalCount).toBe(1);
  });

  test("a reconciled session that resumed lists as running, not ended", async () => {
    const app2 = sessionRoutes({
      ...ctx,
      sessionIndex: {
        ready: true,
        rows: () => [
          { key: "resumed", value: reconciled(5, 0.1) },
          { key: "finalised", value: reconciled(5, 5) },
        ],
      },
    } as unknown as AppContext);
    const res = await app2.fetch(new Request("http://localhost/sessions"));
    const body = (await res.json()) as any;
    const by = Object.fromEntries(body.sessions.map((s: any) => [s.sessionId, s]));
    expect(by.resumed.status).toBe("running");
    expect(by.resumed.endReason).toBe("running");
    expect(by.finalised.status).toBe("ended");
    expect(by.finalised.source).toBe("reconcile");
  });

  test("rejects a status that doesn't exist", async () => {
    const res = await app.fetch(new Request("http://localhost/sessions?status=crashed"));
    expect(res.status).toBe(400);
  });
});

describe("sessionStatus", () => {
  const now = Date.parse("2026-11-09T12:00:00Z");
  const ago = (h: number) => new Date(now - h * 3600_000).toISOString();
  const window = 2 * 3600_000;
  const agg = (last: string, summary: object | null = null) =>
    ({ last, first: last, summary }) as any;

  test("quiet past the window without SessionEnd reads as incomplete", () => {
    // The #272 case: no SessionEnd, last event ~23.5h ago.
    expect(sessionStatus(agg(ago(23.5)), now, window)).toBe("incomplete");
    expect(sessionStatus(agg(ago(1)), now, window)).toBe("running");
  });

  test("a hook-written summary is final, even with later events", () => {
    const s = { timestamp: ago(3), source: "live" };
    expect(sessionStatus(agg(ago(1), s), now, window)).toBe("ended");
  });

  test("a reconciled summary holds until the session records more activity", () => {
    const s = { timestamp: ago(5), source: "reconcile" };
    expect(sessionStatus(agg(ago(5), s), now, window)).toBe("ended");
    expect(sessionStatus(agg(ago(0.1), s), now, window)).toBe("running");
    expect(sessionStatus(agg(ago(3), s), now, window)).toBe("incomplete");
  });

  test("reconciledThenResumed compares instants, not strings", () => {
    const s = { timestamp: "2026-11-09T10:00:00Z", source: "reconcile" };
    expect(reconciledThenResumed(s, "2026-11-09T10:00:00.000Z")).toBe(false);
    expect(reconciledThenResumed(s, "2026-11-09T10:00:00.001Z")).toBe(true);
    expect(reconciledThenResumed(s, "")).toBe(false);
    expect(reconciledThenResumed(null, "2026-11-09T11:00:00Z")).toBe(false);
  });
});

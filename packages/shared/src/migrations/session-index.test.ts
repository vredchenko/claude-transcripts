/**
 * `session_index/aggregate` must give the same row however CouchDB orders and groups
 * the map values it reduces and re-reduces (#119).
 */
import { describe, expect, test } from "bun:test";
import { SESSION_INDEX_DESIGN } from "./session-index";

type Fn = (...args: any[]) => any;
const view = SESSION_INDEX_DESIGN.views.aggregate as { map: string; reduce: string };
const reduce = new Function(`return ${view.reduce}`)() as Fn;
const mapFn = new Function("emit", `return ${view.map}`);

function mapAll(docs: Record<string, unknown>[]): unknown[] {
  const out: unknown[] = [];
  const map = mapFn((_k: unknown, v: unknown) => out.push(v)) as Fn;
  for (const d of docs) map(d);
  return out;
}

const doc = (ts: string, extra: Record<string, unknown> = {}) => ({
  session_id: "s",
  type: "event",
  event: "PostToolUse",
  timestamp: ts,
  hostname: "host-b",
  ...extra,
});

const DOCS = [
  doc("2026-01-01T00:00:03Z", { cwd: "/repo/sub", tool_name: "Read" }),
  doc("2026-01-01T00:00:01Z", { event: "SessionStart", cwd: "/repo", model: "m-1" }),
  doc("2026-01-01T00:00:05Z", { cwd: "/elsewhere", tool_name: "Bash", hostname: "host-a" }),
  doc("2026-01-01T00:00:01Z", { event: "UserPromptSubmit", cwd: "/a-tie", hostname: "" }),
  { session_id: "s", type: "chunk", entries: [{}, {}], byte_end: 40 },
  doc("2026-01-01T00:00:09Z", { type: "summary", event: undefined, model: "m-2", cwd: "/z" }),
];

/** Reduce `values` in randomly sized groups, then re-reduce the partials, recursively. */
function reduceGrouped(values: unknown[], rand: () => number): unknown {
  if (values.length <= 1 || rand() < 0.3) return reduce(null, values, false);
  const parts: unknown[] = [];
  for (let i = 0; i < values.length; ) {
    const n = 1 + Math.floor(rand() * values.length);
    parts.push(reduceGrouped(values.slice(i, i + n), rand));
    i += n;
  }
  return reduce(null, parts, true);
}

function rng(seed: number): () => number {
  return () => {
    seed = (seed * 1103515245 + 12345) % 2 ** 31;
    return seed / 2 ** 31;
  };
}

function shuffle<T>(xs: T[], rand: () => number): T[] {
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j] as T, a[i] as T];
  }
  return a;
}

describe("session_index/aggregate", () => {
  const values = mapAll(DOCS);
  const baseline = reduce(null, values, false);

  test("keeps the earliest doc's model, cwd and hostname", () => {
    expect(baseline.model).toBe("m-1");
    // Two docs share the earliest timestamp: the smaller value wins.
    expect(baseline.cwd).toBe("/a-tie");
    expect(baseline.hostname).toBe("host-b");
    expect(baseline.first).toBe("2026-01-01T00:00:01Z");
    expect(baseline.last).toBe("2026-01-01T00:00:09Z");
    expect(baseline.tools).toEqual({ Bash: 1, Read: 1 });
    expect(baseline.chunkEntries).toBe(2);
  });

  test("is identical under any value order and re-reduce grouping", () => {
    for (let seed = 1; seed <= 200; seed++) {
      const rand = rng(seed);
      const out = reduceGrouped(shuffle(values, rand), rand);
      // Stringify, so tool key order counts too.
      expect(JSON.stringify(out)).toBe(JSON.stringify(baseline));
    }
  });
});

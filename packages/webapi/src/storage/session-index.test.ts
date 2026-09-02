/**
 * The in-memory session index.
 *
 * What matters here is not that it caches — it's that it never lies. The list route
 * reads this instead of CouchDB, so every assertion below is about a way the index
 * could quietly answer with something other than what the view would have said: a
 * failed load that leaves it claiming to be warm, a refresh that drops sessions it
 * wasn't asked about, or a reload that empties the map when CouchDB is briefly down.
 */
import { describe, expect, test } from "bun:test";
import type { SessionAggregate } from "@claude-transcripts/shared";
import { type AggregateView, createSessionIndex } from "./session-index";

function agg(events: number): SessionAggregate {
  return {
    ended: 0,
    events,
    prompts: 0,
    errors: 0,
    started: 1,
    tools: {},
    first: "2026-03-18T09:00:00.000Z",
    last: "2026-03-18T09:30:00.000Z",
    model: "claude-opus-5",
    cwd: "/repo",
    hostname: "box",
    summary: null,
    chunkEntries: 0,
    chunkBytes: 0,
  };
}

/**
 * Run `fn` with `console.error` captured, returning what it logged.
 *
 * The three tests below break the view deliberately, and the production code correctly
 * logs the failure *with its stack* — that is the right behaviour for a real outage. But
 * printed from a **passing** test, three stacks per full-suite run read exactly like a
 * suite that is failing. That has already cost real time: the stacks were misread as a
 * flaky test and the misreading was published in a PR comment before anyone checked.
 *
 * Capturing keeps the assertion that matters (the failure *is* logged, loudly) and drops
 * the noise that made a green run look red.
 */
async function withCapturedErrors(fn: () => Promise<void>): Promise<unknown[][]> {
  const original = console.error;
  const captured: unknown[][] = [];
  console.error = (...args: unknown[]) => {
    captured.push(args);
  };
  try {
    await fn();
  } finally {
    console.error = original;
  }
  return captured;
}

/** A fake view over a mutable corpus, recording how it was queried. */
function fakeView(corpus: Record<string, SessionAggregate>) {
  const calls: Record<string, unknown>[] = [];
  let fail: string | null = null;
  const db: AggregateView = {
    async view(_design, _name, params) {
      calls.push(params);
      if (fail) throw new Error(fail);
      const keys = params.keys as string[] | undefined;
      const wanted = keys ?? Object.keys(corpus);
      return {
        rows: wanted
          .filter((key) => corpus[key] !== undefined)
          .map((key) => ({ key, value: corpus[key] })),
      };
    },
  };
  return {
    db,
    calls,
    corpus,
    breakWith(message: string) {
      fail = message;
    },
    repair() {
      fail = null;
    },
  };
}

describe("load", () => {
  test("is not ready until a load succeeds, and holds every session after", async () => {
    const view = fakeView({ a: agg(1), b: agg(2) });
    const index = createSessionIndex(view.db);

    expect(index.ready).toBe(false);
    expect(index.rows()).toEqual([]);

    await index.load();

    expect(index.ready).toBe(true);
    expect(
      index
        .rows()
        .map((r) => r.key)
        .sort(),
    ).toEqual(["a", "b"]);
    expect(index.get("b")?.events).toBe(2);
    expect(index.status().sessions).toBe(2);
    expect(index.status().loadedAt).toBeTruthy();
  });

  test("asks for the grouped reduce, which is the whole point of caching it", async () => {
    const view = fakeView({ a: agg(1) });
    await createSessionIndex(view.db).load();
    expect(view.calls[0]).toEqual({ group: true, reduce: true });
  });

  test("a failed first load leaves it cold, so callers fall back rather than see nothing", async () => {
    const view = fakeView({ a: agg(1) });
    view.breakWith("couch is down");
    const index = createSessionIndex(view.db);

    const logged = await withCapturedErrors(() => index.load());

    expect(logged).toHaveLength(1);
    expect(index.ready).toBe(false);
    expect(index.rows()).toEqual([]);
    expect(index.status().error).toContain("couch is down");
  });

  test("a failed reload keeps serving the last good answer", async () => {
    const view = fakeView({ a: agg(1) });
    const index = createSessionIndex(view.db);
    await index.load();

    view.breakWith("couch went away");
    const logged = await withCapturedErrors(() => index.load());

    expect(logged).toHaveLength(1);
    // The dangerous outcome would be an empty-but-ready index: a list that renders
    // "no sessions" as though that were the truth.
    expect(index.ready).toBe(true);
    expect(index.rows()).toHaveLength(1);
    expect(index.status().error).toContain("couch went away");
  });

  test("concurrent loads share one query", async () => {
    const view = fakeView({ a: agg(1) });
    const index = createSessionIndex(view.db);

    await Promise.all([index.load(), index.load(), index.load()]);

    expect(view.calls).toHaveLength(1);
  });

  test("a reload picks up sessions that appeared since", async () => {
    const view = fakeView({ a: agg(1) });
    const index = createSessionIndex(view.db);
    await index.load();

    view.corpus.b = agg(5);
    await index.load();

    expect(index.rows()).toHaveLength(2);
  });
});

describe("refresh", () => {
  test("re-reads only the named sessions and leaves the rest alone", async () => {
    const view = fakeView({ a: agg(1), b: agg(2) });
    const index = createSessionIndex(view.db);
    await index.load();

    view.corpus.a = agg(99);
    view.corpus.b = agg(88);
    await index.refresh(["a"]);

    expect(index.get("a")?.events).toBe(99);
    // Not asked about, so not re-read — and, crucially, not dropped.
    expect(index.get("b")?.events).toBe(2);
    expect(view.calls[1]).toEqual({ group: true, reduce: true, keys: ["a"] });
  });

  test("adds a session the index had never seen", async () => {
    const view = fakeView({ a: agg(1) });
    const index = createSessionIndex(view.db);
    await index.load();

    view.corpus.new = agg(3);
    await index.refresh(["new"]);

    expect(index.get("new")?.events).toBe(3);
    expect(index.status().updatedAt).toBeTruthy();
  });

  test("de-duplicates ids and batches at 100 keys", async () => {
    const corpus: Record<string, SessionAggregate> = {};
    for (let i = 0; i < 250; i++) corpus[`s${i}`] = agg(i);
    const view = fakeView(corpus);
    const index = createSessionIndex(view.db);
    await index.load();

    const ids = Object.keys(corpus);
    await index.refresh([...ids, ...ids]);

    const batches = view.calls.slice(1).map((c) => (c.keys as string[]).length);
    expect(batches).toEqual([100, 100, 50]);
  });

  test("does nothing while cold — the pending load will cover it", async () => {
    const view = fakeView({ a: agg(1) });
    const index = createSessionIndex(view.db);

    await index.refresh(["a"]);

    expect(view.calls).toHaveLength(0);
  });

  test("a failed refresh is staleness, not data loss", async () => {
    const view = fakeView({ a: agg(1) });
    const index = createSessionIndex(view.db);
    await index.load();

    view.breakWith("transient");
    const logged = await withCapturedErrors(() => index.refresh(["a"]));

    // A missed patch must still be reported — silent staleness is the worse failure.
    expect(logged).toHaveLength(1);
    expect(index.ready).toBe(true);
    expect(index.get("a")?.events).toBe(1);
  });
});

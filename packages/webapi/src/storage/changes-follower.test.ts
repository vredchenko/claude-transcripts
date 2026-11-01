/**
 * The change follower's checkpoint.
 *
 * The bug these guard against (#89) was not a failure: indexing stayed correct while
 * the follower wrote 5.1M revisions of its own checkpoint into the database it was
 * following, because each write was a change that woke the feed that wrote again. So
 * the assertions are about *where* and *how often* it writes, not about what it stores
 * — a checkpoint that lands back in `_changes` re-opens the loop while every test
 * about its value still passes.
 */
import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import {
  type CheckpointStore,
  createSearchFlusher,
  readCheckpoint,
  startChangesFollower,
  writeCheckpoint,
} from "./changes-follower";

/** A fake database that records every call and answers from a fixed doc map. */
function fakeStore(docs: Record<string, any> = {}) {
  const calls: string[] = [];
  const store = { ...docs };
  const db: CheckpointStore = {
    async get(id) {
      calls.push(`get ${id}`);
      if (!(id in store)) throw new Error("missing");
      return store[id];
    },
    async insert(doc, docName) {
      calls.push(`insert ${docName ?? doc._id}`);
      store[docName ?? doc._id] = { ...doc, _rev: "0-1" };
      return { ok: true };
    },
    async destroy(id, rev) {
      calls.push(`destroy ${id} ${rev}`);
      delete store[id];
      return { ok: true };
    },
  };
  return { db, calls, store };
}

const LOCAL = "_local/search_checkpoint";
const LEGACY = "search_checkpoint";

describe("writeCheckpoint", () => {
  test("writes to a _local doc, which CouchDB keeps out of _changes", async () => {
    const { db, calls, store } = fakeStore();
    await writeCheckpoint(db, "42-abc");

    expect(calls).toEqual([`insert ${LOCAL}`]);
    expect(store[LOCAL].seq).toBe("42-abc");
    // The id is passed as the doc name too, so nano PUTs the _local path rather than
    // POSTing a doc whose id merely starts with `_local/`.
    expect(store[LOCAL]._id).toBe(LOCAL);
  });
});

describe("readCheckpoint", () => {
  test("reads the _local doc when there is one", async () => {
    const { db, calls } = fakeStore({ [LOCAL]: { _id: LOCAL, seq: "7-g" } });

    expect(await readCheckpoint(db)).toBe("7-g");
    expect(calls).toEqual([`get ${LOCAL}`]);
  });

  test("adopts a pre-#89 checkpoint, then deletes it", async () => {
    const { db, calls, store } = fakeStore({
      [LEGACY]: { _id: LEGACY, _rev: "5117394-deadbeef", type: "search_checkpoint", seq: "99-z" },
    });

    // Resuming from the old position rather than `now`: everything written between
    // that checkpoint and this boot would otherwise never reach the index.
    expect(await readCheckpoint(db)).toBe("99-z");
    expect(store[LOCAL].seq).toBe("99-z");
    expect(store[LEGACY]).toBeUndefined();
    // Order matters: a crash between the two costs a replay, the reverse costs the
    // position outright.
    expect(calls).toEqual([
      `get ${LOCAL}`,
      `get ${LEGACY}`,
      `insert ${LOCAL}`,
      `destroy ${LEGACY} 5117394-deadbeef`,
    ]);
  });

  test("the _local doc wins, and the legacy doc is left alone once migrated", async () => {
    const { db, calls } = fakeStore({
      [LOCAL]: { _id: LOCAL, seq: "10-new" },
      [LEGACY]: { _id: LEGACY, type: "search_checkpoint", seq: "1-stale" },
    });

    expect(await readCheckpoint(db)).toBe("10-new");
    expect(calls).toEqual([`get ${LOCAL}`]);
  });

  test("leaves a doc it doesn't recognise in place", async () => {
    const { db, store } = fakeStore({
      [LEGACY]: { _id: LEGACY, _rev: "1-x", type: "something_else", seq: "3-c" },
    });

    expect(await readCheckpoint(db)).toBeNull();
    expect(store[LEGACY]).toBeDefined();
  });

  test("a failed delete still keeps the adopted position", async () => {
    const { db, store } = fakeStore({
      [LEGACY]: { _id: LEGACY, _rev: "1-x", type: "search_checkpoint", seq: "12-l" },
    });
    db.destroy = async () => {
      throw new Error("conflict");
    };

    expect(await readCheckpoint(db)).toBe("12-l");
    expect(store[LOCAL].seq).toBe("12-l");
  });

  test("a legacy doc with no usable seq is dropped, not adopted", async () => {
    const { db, calls, store } = fakeStore({
      [LEGACY]: { _id: LEGACY, _rev: "1-x", type: "search_checkpoint" },
    });

    expect(await readCheckpoint(db)).toBeNull();
    expect(store[LEGACY]).toBeUndefined();
    expect(calls).not.toContain(`insert ${LOCAL}`);
  });
});

/**
 * A fake app context for the search half: Meilisearch and the checkpoint store share
 * one call log, so a test can assert the *order* of index and checkpoint writes.
 * `hold()` parks the next index call until the returned release is called.
 *
 * Sessions are running unless listed in `ended`; `chunks` is what CouchDB holds per
 * session, `held` is what the live index reports holding, and `failArchive` makes
 * Meilisearch reject archive writes.
 */
function fakeSearch(
  opts: {
    ended?: string[];
    chunks?: Record<string, any[]>;
    held?: string[];
    failArchive?: boolean;
  } = {},
) {
  const log: string[] = [];
  const { db: store } = fakeStore();
  let gate: Promise<void> | null = null;
  const feed = new EventEmitter();
  const ended = new Set(opts.ended ?? []);
  const db: any = {
    ...store,
    async insert(doc: any, docName?: string) {
      log.push(`checkpoint ${doc.seq}`);
      return store.insert(doc, docName);
    },
    async view(design: string, name: string, params: any) {
      if (design === "chunks" && name === "by_session") {
        const id = params.startkey[0];
        return { rows: (opts.chunks?.[id] ?? []).map((doc) => ({ doc })) };
      }
      throw new Error(`unexpected view ${design}/${name}`);
    },
    changesReader: {
      start: () => feed,
      resume() {},
      stop() {
        log.push("feed stopped");
      },
    },
  };
  const agg = (id: string) => ({
    last: new Date().toISOString(),
    events: 1,
    id,
    ...(ended.has(id) ? { summary: { session_id: id } } : {}),
  });
  const ctx: any = {
    config: {
      system: {},
      meili: {
        indexes: { sessions: "x-sessions", turns: "x-turns", liveTurns: "x-live" },
      },
    },
    couch: { db: () => db },
    sessionIndex: {
      ready: true,
      get: agg,
      rows: () => [],
      refresh: async () => {},
    },
    meili: {
      enabled: true,
      async index(uid: string, docs: any[]) {
        if (gate) {
          const g = gate;
          gate = null;
          await g;
        }
        log.push(`index ${uid} ${docs.map((d) => d.id).join(",")}`);
        return uid === "x-turns" && opts.failArchive ? 99 : 1;
      },
      async taskFailures(uids: number[]) {
        return { indexed: 0, failures: uids.includes(99) ? ["rejected"] : [] };
      },
      async deleteDocs(uid: string, target: any) {
        log.push(`delete ${uid} ${target.filter}`);
        return 2;
      },
      async deleteIndex() {
        return 3;
      },
      async ensureIndex() {},
      async swapIndexes(a: string, b: string) {
        log.push(`swap ${a} ${b}`);
        return 4;
      },
      async facets(uid: string) {
        log.push(`facets ${uid}`);
        return { sessionId: opts.held ?? [] };
      },
      async pruneTasks(uids: string[]) {
        log.push(`prune ${uids.join(",")}`);
        return 1;
      },
    },
  };
  const hold = () => {
    let release!: () => void;
    gate = new Promise<void>((r) => {
      release = r;
    });
    return release;
  };
  return { ctx, db, log, feed, hold, ended };
}

const chunk = (session_id: string, byte_start: number) => ({
  type: "chunk",
  session_id,
  byte_start,
  entries: [{ role: "user", text: "hi" }],
});

const turn = (id: string, sessionId = "s1") => ({ id, sessionId });

describe("search flush", () => {
  test("indexes once per index, then checkpoints the seq it covered", async () => {
    const { ctx, db, log } = fakeSearch();
    const { buffer, flush } = createSearchFlusher(ctx, db);
    buffer.addTurns([turn("t1"), turn("t2")]);
    buffer.touch("s1");
    buffer.advance("9-a");

    await flush();

    expect(log).toEqual([
      "index x-sessions s1",
      "index x-live t1,t2",
      "checkpoint 9-a",
      "prune x-sessions,x-sessions-rebuild,x-turns,x-turns-rebuild,x-live,x-live-rebuild",
    ]);
  });

  test("an ended session's turns never go to an index on flush — they wait for promotion", async () => {
    const { ctx, db, log } = fakeSearch({ ended: ["old"] });
    const { buffer, flush } = createSearchFlusher(ctx, db);
    buffer.addTurns([turn("run", "s1"), turn("late", "old")]);
    buffer.addSummary("s2", { id: "s2" });
    buffer.addTurns([turn("final", "s2")]);

    await flush();

    // Neither the backfilled/late turn nor the one whose summary arrived in the same
    // batch touches the archive here: the archive is written only by promotion.
    expect(log.filter((l) => l.startsWith("index"))).toEqual([
      "index x-sessions s2",
      "index x-live run",
    ]);
  });

  test("a flush asked for mid-flush runs after it, carrying the docs that arrived", async () => {
    const { ctx, db, log, hold } = fakeSearch();
    const { buffer, flush } = createSearchFlusher(ctx, db);
    buffer.addTurns([turn("early")]);
    buffer.advance("1-a");
    const release = hold();
    const first = flush();

    buffer.addTurns([turn("late")]);
    buffer.advance("2-b");
    const second = flush();
    release();
    await Promise.all([first, second]);

    expect(log.filter((l) => !l.startsWith("prune"))).toEqual([
      "index x-live early",
      "checkpoint 1-a",
      "index x-live late",
      "checkpoint 2-b",
    ]);
  });

  test("prunes at most once per retention period", async () => {
    const { ctx, db, log } = fakeSearch();
    const { flush } = createSearchFlusher(ctx, db, 60_000);
    await flush();
    await flush();
    expect(log.filter((l) => l.startsWith("prune")).length).toBe(1);
  });
});

describe("search maintenance", () => {
  test("promotes an ended session: archive from CouchDB first, then out of live", async () => {
    const { ctx, db, log } = fakeSearch({ ended: ["s1"], chunks: { s1: [chunk("s1", 0)] } });
    const { buffer, flush, maintain } = createSearchFlusher(ctx, db);
    buffer.addSummary("s1", { id: "s1" });
    await flush();
    log.length = 0;

    await maintain();

    expect(log).toEqual([
      "facets x-live",
      "index x-turns s1_0_0",
      'delete x-live sessionId IN ["s1"]',
      // The first pass after boot also rebuilds the live index, by swap.
      "swap x-live x-live-rebuild",
    ]);
  });

  test("finds ended sessions the live index still holds, e.g. after a restart", async () => {
    const { ctx, db, log } = fakeSearch({
      ended: ["gone"],
      held: ["gone", "running"],
      chunks: { gone: [chunk("gone", 5)] },
    });
    const { maintain } = createSearchFlusher(ctx, db);

    await maintain();

    expect(log).toEqual([
      "facets x-live",
      "index x-turns gone_5_0",
      'delete x-live sessionId IN ["gone"]',
      "swap x-live x-live-rebuild",
    ]);
  });

  test("an archive write that fails leaves the session live, and is retried", async () => {
    const { ctx, db, log } = fakeSearch({
      ended: ["s1"],
      held: [],
      chunks: { s1: [chunk("s1", 0)] },
      failArchive: true,
    });
    const { buffer, flush, maintain } = createSearchFlusher(ctx, db);
    buffer.addSummary("s1", { id: "s1" });
    await flush();
    log.length = 0;

    await maintain();
    expect(log.some((l) => l.startsWith("delete"))).toBe(false);

    log.length = 0;
    await maintain();
    expect(log).toContain("index x-turns s1_0_0");
  });

  test("queues behind a flush instead of overlapping it", async () => {
    const { ctx, db, log, hold } = fakeSearch({ ended: ["s1"], chunks: { s1: [chunk("s1", 0)] } });
    const { buffer, flush, maintain } = createSearchFlusher(ctx, db);
    buffer.addTurns([turn("t1", "s9")]);
    buffer.addSummary("s1", { id: "s1" });
    const release = hold();
    const first = flush();
    const second = maintain();
    release();
    await Promise.all([first, second]);

    const order = log.filter((l) => !l.startsWith("prune"));
    expect(order.indexOf("index x-live t1")).toBeLessThan(order.indexOf("facets x-live"));
  });
});

describe("startChangesFollower", () => {
  const nextTick = () => new Promise((r) => setTimeout(r, 0));

  test("a live session's end flushes at once; a running one waits for the interval", async () => {
    const { ctx, log, feed, ended } = fakeSearch();
    const follower = startChangesFollower(ctx);
    await nextTick(); // let it read the checkpoint and start the feed

    feed.emit("batch", [{ seq: "1-a", doc: chunk("s1", 0) }]);
    await nextTick();
    expect(log).toEqual([]); // buffered, not sent

    ended.add("s1");
    feed.emit("batch", [{ seq: "2-b", doc: { type: "summary", session_id: "s1" } }]);
    await nextTick();
    // The session row is written at once; its turns wait for promotion.
    expect(log.slice(0, 2)).toEqual(["index x-sessions s1", "checkpoint 2-b"]);
    await follower.stop();
  });

  test("stop resolves only after the buffered rows are flushed and checkpointed", async () => {
    const { ctx, log, feed } = fakeSearch();
    const follower = startChangesFollower(ctx);
    await nextTick();

    feed.emit("batch", [{ seq: "3-c", doc: chunk("s2", 10) }]);
    await nextTick();
    await follower.stop();

    expect(log.slice(0, 3)).toEqual(["feed stopped", "index x-live s2_10_0", "checkpoint 3-c"]);
  });
});

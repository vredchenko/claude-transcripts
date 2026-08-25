/**
 * The search follower's checkpoint.
 *
 * The bug these guard against (#89) was not a failure: indexing stayed correct while
 * the follower wrote 5.1M revisions of its own checkpoint into the database it was
 * following, because each write was a change that woke the feed that wrote again. So
 * the assertions are about *where* and *how often* it writes, not about what it stores
 * — a checkpoint that lands back in `_changes` re-opens the loop while every test
 * about its value still passes.
 */
import { describe, expect, test } from "bun:test";
import { type CheckpointStore, readCheckpoint, writeCheckpoint } from "./search-follower";

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

  test("does not read before writing — a _local doc needs no _rev", async () => {
    const { db, calls } = fakeStore({ [LOCAL]: { _id: LOCAL, _rev: "0-1", seq: "1-a" } });
    await writeCheckpoint(db, "2-b");

    expect(calls.filter((c) => c.startsWith("get"))).toEqual([]);
  });

  test("swallows a write failure — a lost checkpoint costs a replay, not correctness", async () => {
    const db: CheckpointStore = {
      async get() {
        throw new Error("down");
      },
      async insert() {
        throw new Error("down");
      },
      async destroy() {
        throw new Error("down");
      },
    };
    expect(await writeCheckpoint(db, "1-a")).toBeUndefined();
  });
});

describe("readCheckpoint", () => {
  test("reads the _local doc when there is one", async () => {
    const { db, calls } = fakeStore({ [LOCAL]: { _id: LOCAL, seq: "7-g" } });

    expect(await readCheckpoint(db)).toBe("7-g");
    expect(calls).toEqual([`get ${LOCAL}`]);
  });

  test("a fresh instance has neither doc, and starts at `now`", async () => {
    const { db } = fakeStore();
    expect(await readCheckpoint(db)).toBeNull();
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

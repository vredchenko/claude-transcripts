/**
 * The active-duration read.
 *
 * Every assertion here is about a way this can quietly report the wrong thing rather
 * than fail: a session drawn as "0s active" because its view rows never arrived, a
 * cached answer served after new events landed, or a list that 500s because an
 * instance hasn't applied the migration that creates the view.
 */
import { describe, expect, test } from "bun:test";
import {
  type ActiveQuery,
  activeDurations,
  createActiveDurationCache,
  groupTimestamps,
  type TimestampView,
} from "./active-duration";

const MINUTE = 60_000;
const IDLE = 5 * MINUTE;

function at(minutes: number): string {
  return new Date(Date.parse("2026-03-18T09:00:00.000Z") + minutes * MINUTE).toISOString();
}

/** A fake view that answers from a fixed corpus and counts what it was asked. */
function fakeView(corpus: Record<string, string[]>) {
  const calls: string[][] = [];
  const db: TimestampView = {
    async view(_design, _name, params) {
      calls.push(params.keys);
      return {
        rows: params.keys.flatMap((key) => (corpus[key] ?? []).map((value) => ({ key, value }))),
      };
    },
  };
  return { db, calls };
}

function query(sessionId: string, through = "z"): ActiveQuery {
  return { sessionId, through };
}

describe("groupTimestamps", () => {
  test("collects a row's value under its key", () => {
    const grouped = groupTimestamps([
      { key: "a", value: at(0) },
      { key: "b", value: at(1) },
      { key: "a", value: at(2) },
    ]);
    expect(grouped.get("a")).toEqual([at(0), at(2)]);
    expect(grouped.get("b")).toEqual([at(1)]);
  });

  test("skips rows a view can legitimately emit but this can't use", () => {
    // Views are recomputed over whatever documents exist, including ones written by
    // an older hook — a missing or non-string timestamp must not become "NaN".
    const grouped = groupTimestamps([
      { key: "a", value: null },
      { key: "a", value: "" },
      { key: "a", value: 42 },
      { key: "a", value: at(0) },
    ]);
    expect(grouped.get("a")).toEqual([at(0)]);
  });
});

describe("activeDurations", () => {
  test("sums the gaps within the idle threshold and drops the ones beyond it", async () => {
    // Two minutes of work, an hour of nothing, then three more minutes of work.
    const { db } = fakeView({ s1: [at(0), at(2), at(62), at(65)] });
    const active = await activeDurations(db, [query("s1")], IDLE, createActiveDurationCache());
    expect(active.get("s1")).toBe(5 * MINUTE);
  });

  test("reports nothing for a session with too few timestamps to measure a gap", async () => {
    // Absent, not zero: "ran and did nothing" is a different claim from "can't say".
    const { db } = fakeView({ s1: [at(0)], s2: [] });
    const active = await activeDurations(
      db,
      [query("s1"), query("s2")],
      IDLE,
      createActiveDurationCache(),
    );
    expect(active.has("s1")).toBe(false);
    expect(active.has("s2")).toBe(false);
  });

  test("answers for many sessions in one request", async () => {
    const { db, calls } = fakeView({
      s1: [at(0), at(1)],
      s2: [at(0), at(3)],
    });
    const active = await activeDurations(
      db,
      [query("s1"), query("s2")],
      IDLE,
      createActiveDurationCache(),
    );
    expect(calls).toEqual([["s1", "s2"]]);
    expect(active.get("s1")).toBe(MINUTE);
    expect(active.get("s2")).toBe(3 * MINUTE);
  });

  test("serves a repeat question from the memo instead of the view", async () => {
    const { db, calls } = fakeView({ s1: [at(0), at(1)] });
    const cache = createActiveDurationCache();
    await activeDurations(db, [query("s1", "t1")], IDLE, cache);
    const again = await activeDurations(db, [query("s1", "t1")], IDLE, cache);
    expect(calls).toHaveLength(1);
    expect(again.get("s1")).toBe(MINUTE);
  });

  test("recomputes once the session has newer activity", async () => {
    // A running session's answer is not final; the newest timestamp is the handle.
    const corpus: Record<string, string[]> = { s1: [at(0), at(1)] };
    const { db, calls } = fakeView(corpus);
    const cache = createActiveDurationCache();
    await activeDurations(db, [query("s1", at(1))], IDLE, cache);
    corpus.s1 = [at(0), at(1), at(4)];
    const after = await activeDurations(db, [query("s1", at(4))], IDLE, cache);
    expect(calls).toHaveLength(2);
    expect(after.get("s1")).toBe(4 * MINUTE);
  });

  test("does not re-query a session it already found nothing for", async () => {
    const { db, calls } = fakeView({ s1: [at(0)] });
    const cache = createActiveDurationCache();
    await activeDurations(db, [query("s1")], IDLE, cache);
    await activeDurations(db, [query("s1")], IDLE, cache);
    expect(calls).toHaveLength(1);
  });

  test("a different idle threshold is a different question", async () => {
    const corpus = { s1: [at(0), at(2), at(62), at(65)] };
    const { db } = fakeView(corpus);
    const cache = createActiveDurationCache();
    expect((await activeDurations(db, [query("s1")], IDLE, cache)).get("s1")).toBe(5 * MINUTE);
    // Two hours of tolerance swallows the hour-long gap, so the whole span is active.
    expect((await activeDurations(db, [query("s1")], 2 * 60 * MINUTE, cache)).get("s1")).toBe(
      65 * MINUTE,
    );
  });

  test("batches a large request rather than sending one enormous key list", async () => {
    const ids = Array.from({ length: 250 }, (_, i) => `s${i}`);
    const corpus = Object.fromEntries(ids.map((id) => [id, [at(0), at(1)]]));
    const { db, calls } = fakeView(corpus);
    const active = await activeDurations(
      db,
      ids.map((id) => query(id)),
      IDLE,
      createActiveDurationCache(),
    );
    expect(calls.map((keys) => keys.length)).toEqual([100, 100, 50]);
    expect(active.size).toBe(250);
  });

  test("costs the reader the split, not the list, when the view isn't there", async () => {
    // What an instance that hasn't applied migration v9 does: the view 404s.
    const db: TimestampView = {
      async view() {
        throw new Error("missing_named_view");
      },
    };
    const active = await activeDurations(db, [query("s1")], IDLE, createActiveDurationCache());
    expect(active.size).toBe(0);
  });

  test("keeps whatever it answered before a failed batch", async () => {
    let call = 0;
    const db: TimestampView = {
      async view(_design, _name, params) {
        call++;
        if (call > 1) throw new Error("CouchDB went away");
        return { rows: params.keys.map((key) => ({ key, value: at(0) })) };
      },
    };
    // 150 sessions is two batches: the first answers (one timestamp each → nothing
    // derivable), the second throws. The call must still resolve.
    const ids = Array.from({ length: 150 }, (_, i) => query(`s${i}`));
    await expect(
      activeDurations(db, ids, IDLE, createActiveDurationCache()),
    ).resolves.toBeDefined();
  });

  test("evicts the oldest entry when the memo is full", async () => {
    const cache = createActiveDurationCache(2);
    const { db, calls } = fakeView({
      s1: [at(0), at(1)],
      s2: [at(0), at(1)],
      s3: [at(0), at(1)],
    });
    await activeDurations(db, [query("s1")], IDLE, cache);
    await activeDurations(db, [query("s2")], IDLE, cache);
    await activeDurations(db, [query("s3")], IDLE, cache);
    expect(cache.size).toBe(2);
    // s1 was evicted, so asking again goes back to the view; s3 is still memoised.
    await activeDurations(db, [query("s1")], IDLE, cache);
    await activeDurations(db, [query("s3")], IDLE, cache);
    expect(calls).toHaveLength(4);
  });
});

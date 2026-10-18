/**
 * The search buffer exists to turn many small Meilisearch updates into few (#231), so
 * these pin the collapsing: repeated work is one row, and a summary is never shadowed
 * by the running-session row it supersedes.
 */
import { describe, expect, test } from "bun:test";
import { bufferForSearch } from "./changes-follower";
import { SearchBuffer } from "./search-buffer";

const event = (session_id: string) => ({ type: "event", session_id });
const summary = (session_id: string) => ({
  type: "summary",
  session_id,
  timestamp: "2026-10-18T00:00:00.000Z",
});
const chunk = (session_id: string, byte_start: number, text: string) => ({
  type: "chunk",
  session_id,
  byte_start,
  entries: [{ role: "user", text }],
});

describe("SearchBuffer", () => {
  test("a session that moved many times is one running row", () => {
    const buffer = new SearchBuffer();
    for (let i = 0; i < 40; i++) bufferForSearch(buffer, [event("s1")]);

    const batch = buffer.take();
    expect(batch.running).toEqual(["s1"]);
    expect(batch.summaries.size).toBe(0);
  });

  test("a summary supersedes the session's running row, in either order", () => {
    const before = new SearchBuffer();
    bufferForSearch(before, [event("s1")]);
    bufferForSearch(before, [summary("s1")]);

    const after = new SearchBuffer();
    bufferForSearch(after, [summary("s1")]);
    bufferForSearch(after, [event("s1")]);

    for (const buffer of [before, after]) {
      const batch = buffer.take();
      expect(batch.running).toEqual([]);
      expect([...batch.summaries.keys()]).toEqual(["s1"]);
    }
  });

  test("a chunk written twice is one set of turns, the latest winning", () => {
    const buffer = new SearchBuffer();
    bufferForSearch(buffer, [chunk("s1", 0, "first")]);
    bufferForSearch(buffer, [chunk("s1", 0, "second"), chunk("s1", 100, "other")]);

    const batch = buffer.take();
    expect(batch.turns.size).toBe(2);
    expect([...batch.turns.values()].map((t) => t.text).sort()).toEqual(["other", "second"]);
  });

  test("take hands over the seq with the rows and leaves the buffer empty", () => {
    const buffer = new SearchBuffer();
    bufferForSearch(buffer, [event("s1"), chunk("s1", 0, "hi")]);
    buffer.advance("12-abc");

    const batch = buffer.take();
    expect(batch.seq).toBe("12-abc");
    expect(buffer.size).toBe(0);
    expect(buffer.take()).toMatchObject({ seq: null, running: [] });
  });
});

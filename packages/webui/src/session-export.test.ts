import { describe, expect, test } from "bun:test";
import type { TranscriptResponse } from "./api/generated";
import { fetchFullTranscript } from "./session-export";

/** A fake transcript endpoint over `total` entries, recording each request. */
function fakeEndpoint(total: number, grows = 0) {
  const calls: { offset: number; limit: number }[] = [];
  let size = total;
  const fetchPage = async (
    _id: string,
    params?: { offset?: number | null; limit?: number | null },
  ) => {
    const offset = params?.offset ?? 0;
    const limit = params?.limit ?? 100;
    calls.push({ offset, limit });
    const count = Math.max(0, Math.min(limit, size - offset));
    const page: TranscriptResponse = {
      entries: Array.from({ length: count }, (_, i) => ({
        role: "user",
        text: String(offset + i),
      })),
      totalCount: size,
      hasMore: offset + count < size,
      source: "chunks",
      byteCoverage: 0,
    };
    size += grows; // a live session gaining entries between requests
    return page;
  };
  return { calls, fetchPage };
}

describe("fetchFullTranscript", () => {
  test("pages until it holds totalCount entries, in order", async () => {
    const { calls, fetchPage } = fakeEndpoint(2500);
    const entries = await fetchFullTranscript("s", fetchPage as never);
    expect(entries).toHaveLength(2500);
    expect(entries[2499]?.text).toBe("2499");
    expect(calls.map((c) => c.offset)).toEqual([0, 1000, 2000]);
  });

  test("one request for an empty transcript", async () => {
    const { calls, fetchPage } = fakeEndpoint(0);
    expect(await fetchFullTranscript("s", fetchPage as never)).toEqual([]);
    expect(calls).toHaveLength(1);
  });

  test("terminates on a live session that keeps growing", async () => {
    const { fetchPage } = fakeEndpoint(1500, 10);
    const entries = await fetchFullTranscript("s", fetchPage as never);
    expect(entries.length).toBeGreaterThanOrEqual(1500);
  });
});

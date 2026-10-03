import { describe, expect, test } from "bun:test";
import { chunkDocId, sliceIntoChunks, sumTranscriptTokens } from "./index";

describe("sumTranscriptTokens", () => {
  test("dedupes by message id, keeping the heaviest usage per id", () => {
    const jsonl = [
      JSON.stringify({ type: "user", message: { role: "user", content: "hi" } }),
      // same message id logged twice (streaming); the heavier one must win
      JSON.stringify({ message: { id: "m1", usage: { input_tokens: 10, output_tokens: 5 } } }),
      JSON.stringify({ message: { id: "m1", usage: { input_tokens: 10, output_tokens: 20 } } }),
      JSON.stringify({
        message: {
          id: "m2",
          usage: {
            input_tokens: 100,
            output_tokens: 0,
            cache_creation_input_tokens: 50,
            cache_read_input_tokens: 7,
          },
        },
      }),
      "", // blank line tolerated
      "{ not json", // malformed line tolerated
    ].join("\n");

    const usage = sumTranscriptTokens(jsonl);
    expect(usage.messages).toBe(2); // m1 (deduped) + m2
    expect(usage.input).toBe(110); // 10 (m1 kept) + 100 (m2)
    expect(usage.output).toBe(20); // 20 (m1 heavier) + 0
    expect(usage.cacheCreation).toBe(50);
    expect(usage.cacheRead).toBe(7);
    expect(usage.total).toBe(187); // 110 + 20 + 50 + 7
  });

  test("counts usage-less messages under distinct anon ids (no collapse)", () => {
    const jsonl = [
      JSON.stringify({ message: { usage: { input_tokens: 1 } } }),
      JSON.stringify({ message: { usage: { input_tokens: 2 } } }),
    ].join("\n");
    const usage = sumTranscriptTokens(jsonl);
    expect(usage.messages).toBe(2);
    expect(usage.input).toBe(3);
  });
});

describe("sliceIntoChunks", () => {
  test("tiles the whole transcript with no gaps or overlaps", () => {
    const lines = Array.from({ length: 10 }, (_, i) => JSON.stringify({ n: i }));
    const jsonl = lines.join("\n");
    const slices = sliceIntoChunks(jsonl, 3);

    // consecutive slices tile [0, byteLength] exactly
    expect(slices[0]?.byteStart).toBe(0);
    for (let i = 1; i < slices.length; i++) {
      expect(slices[i]?.byteStart).toBe(slices[i - 1]?.byteEnd);
    }
    const totalBytes = new TextEncoder().encode(jsonl).length;
    expect(slices[slices.length - 1]?.byteEnd).toBe(totalBytes);

    // every entry is accounted for exactly once, at most 3 per chunk
    expect(slices.map((s) => s.entryCount)).toEqual([3, 3, 3, 1]);
  });

  test("empty input yields no slices", () => {
    expect(sliceIntoChunks("")).toEqual([]);
  });
});

describe("chunkDocId", () => {
  test("pads the byte offset so ids sort in byte order", () => {
    expect(chunkDocId("sess", 0)).toBe("chunk:sess:000000000000");
    expect(chunkDocId("sess", 4096)).toBe("chunk:sess:000000004096");
    // lexical order matches numeric order
    expect(chunkDocId("s", 10) < chunkDocId("s", 100)).toBe(true);
  });
});

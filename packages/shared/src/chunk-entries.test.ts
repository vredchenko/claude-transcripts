import { describe, expect, test } from "bun:test";
import { buildChunkEntries, sliceIntoChunks } from "./index";

const lines = [
  JSON.stringify({
    type: "user",
    timestamp: "t1",
    message: { content: [{ type: "text", text: "hello" }] },
  }),
  JSON.stringify({
    type: "assistant",
    timestamp: "t2",
    message: {
      content: [
        { type: "text", text: "hi" },
        { type: "tool_use", name: "Bash", id: "tu_1" },
      ],
    },
  }),
  JSON.stringify({
    type: "user",
    timestamp: "t3",
    message: {
      content: [
        {
          type: "tool_result",
          tool_use_id: "tu_1",
          is_error: true,
          content: [{ type: "text", text: "boom" }],
        },
      ],
    },
  }),
  JSON.stringify({ type: "system", timestamp: "t4", message: { content: "note" } }),
  "{ not valid json",
];
const jsonl = lines.join("\n");

describe("buildChunkEntries", () => {
  test("one entry per non-blank line, roles + fields projected", () => {
    const e = buildChunkEntries(jsonl);
    expect(e.length).toBe(5);
    expect(e[0]).toMatchObject({ role: "user", text: "hello", timestamp: "t1" });
    expect(e[1]).toMatchObject({ role: "assistant", text: "hi" });
    expect(e[1]?.toolUses).toEqual([{ name: "Bash", id: "tu_1" }]);
    expect(e[2]).toMatchObject({
      role: "tool_result",
      toolUseId: "tu_1",
      isError: true,
      text: "boom",
    });
    expect(e[3]).toMatchObject({ role: "system", text: "note" });
    expect(e[4]).toEqual({ role: "other" }); // malformed line → placeholder, count preserved
  });

  test("partitions 1:1 with sliceIntoChunks by entry_count", () => {
    const total = sliceIntoChunks(jsonl, 2).reduce((n, s) => n + s.entryCount, 0);
    expect(total).toBe(buildChunkEntries(jsonl).length);
  });

  test("ignores blank input", () => {
    expect(buildChunkEntries("").length).toBe(0);
    expect(buildChunkEntries("\n\n").length).toBe(0);
  });
});

import { describe, expect, test } from "bun:test";
import { buildEventDocs } from "./session-docs";
import { deriveSessionFacts, isUserPrompt, type TranscriptEntry } from "./transcript";

const ts = (n: number) => `2026-11-01T10:00:${String(n).padStart(2, "0")}Z`;
const base = { sessionId: "s-1", cwd: "/p" };

const prompt = (n: number, text: unknown, extra: Record<string, unknown> = {}) => ({
  ...base,
  type: "user",
  timestamp: ts(n),
  message: { role: "user", content: text },
  ...extra,
});
const toolUse = (n: number, id: string, name: string, extra: Record<string, unknown> = {}) => ({
  ...base,
  type: "assistant",
  timestamp: ts(n),
  message: { id: `m${n}`, model: "m", content: [{ type: "tool_use", id, name, input: {} }] },
  ...extra,
});
const toolResult = (
  n: number,
  id: string,
  isError = false,
  extra: Record<string, unknown> = {},
) => ({
  ...base,
  type: "user",
  timestamp: ts(n),
  message: {
    role: "user",
    content: [{ type: "tool_result", tool_use_id: id, content: "out", is_error: isError }],
  },
  ...extra,
});
const text = (n: number, s: string) => ({
  ...base,
  type: "assistant",
  timestamp: ts(n),
  message: { id: `m${n}`, model: "m", content: [{ type: "text", text: s }] },
});

const jsonl = (...lines: object[]) => lines.map((l) => JSON.stringify(l)).join("\n");

describe("deriveSessionFacts counts", () => {
  test("events are prompts + answered tool calls, as the hook would count them", () => {
    const facts = deriveSessionFacts(
      jsonl(
        { type: "file-history-snapshot" },
        prompt(1, "fix the bug"),
        toolUse(2, "t1", "Read"),
        toolResult(3, "t1"),
        toolUse(4, "t2", "Bash"),
        toolResult(5, "t2", true),
        toolUse(6, "t3", "Bash"),
        toolResult(7, "t3"),
        text(8, "done"),
        prompt(9, [{ type: "text", text: "thanks" }]),
        text(10, "np"),
      ),
    );
    expect(facts.promptCount).toBe(2);
    expect(facts.errorCount).toBe(1);
    expect(facts.toolCounts).toEqual({ Read: 1, Bash: 1 });
    // 2 UserPromptSubmit + 2 PostToolUse + 1 PostToolUseFailure; text turns aren't events
    expect(facts.eventCount).toBe(5);
  });

  test("a tool call with no result fired no Post* hook and is not counted", () => {
    const facts = deriveSessionFacts(jsonl(prompt(1, "go"), toolUse(2, "t1", "Bash")));
    expect(facts.eventCount).toBe(1);
    expect(facts.toolCounts).toEqual({});
    expect(facts.errorCount).toBe(0);
  });

  test("a tool_use repeated across entries counts once", () => {
    const facts = deriveSessionFacts(
      jsonl(toolUse(1, "t1", "Read"), toolUse(1, "t1", "Read"), toolResult(2, "t1")),
    );
    expect(facts.toolCounts).toEqual({ Read: 1 });
    expect(facts.eventCount).toBe(1);
  });

  test("subagent (sidechain) tool calls count, its prompt does not", () => {
    const side = { isSidechain: true };
    const facts = deriveSessionFacts(
      jsonl(
        prompt(1, "research this"),
        prompt(2, "subagent task", side),
        toolUse(3, "t1", "Grep", side),
        toolResult(4, "t1", true, side),
      ),
    );
    expect(facts.promptCount).toBe(1);
    expect(facts.errorCount).toBe(1);
    expect(facts.eventCount).toBe(2);
  });

  test("no transcript content means zero counts", () => {
    const facts = deriveSessionFacts("");
    expect(facts).toMatchObject({ eventCount: 0, promptCount: 0, errorCount: 0, toolCounts: {} });
  });
});

describe("isUserPrompt", () => {
  const e = (l: object) => l as TranscriptEntry;

  test("accepts a typed prompt, string or text blocks", () => {
    expect(isUserPrompt(e(prompt(1, "hi")))).toBe(true);
    expect(isUserPrompt(e(prompt(1, [{ type: "text", text: "hi" }])))).toBe(true);
    expect(isUserPrompt(e(prompt(1, "<command-name>/review</command-name>")))).toBe(true);
  });

  test("rejects what Claude Code writes as a user turn without a UserPromptSubmit", () => {
    expect(isUserPrompt(e(toolResult(1, "t1")))).toBe(false);
    expect(isUserPrompt(e(prompt(1, "   ")))).toBe(false);
    expect(isUserPrompt(e(prompt(1, [{ type: "text", text: "" }])))).toBe(false);
    expect(isUserPrompt(e(prompt(1, "caveat", { isMeta: true })))).toBe(false);
    expect(isUserPrompt(e(prompt(1, "summary", { isCompactSummary: true })))).toBe(false);
    expect(isUserPrompt(e(prompt(1, "[Request interrupted by user]")))).toBe(false);
    expect(
      isUserPrompt(
        e(prompt(1, [{ type: "text", text: "[Request interrupted by user for tool use]" }])),
      ),
    ).toBe(false);
    expect(isUserPrompt(e(prompt(1, "sub", { isSidechain: true })))).toBe(false);
  });
});

test("reconstructed UserPromptSubmit markers match promptCount", () => {
  const src = jsonl(
    prompt(1, "first"),
    prompt(2, "[Request interrupted by user]"),
    prompt(3, "ctx", { isMeta: true }),
    prompt(4, "second"),
  );
  const facts = deriveSessionFacts(src);
  const markers = buildEventDocs(src, facts, "backfill").filter(
    (d) => d.event === "UserPromptSubmit",
  );
  expect(facts.promptCount).toBe(2);
  expect(markers).toHaveLength(2);
});

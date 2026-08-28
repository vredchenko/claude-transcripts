import { describe, expect, test } from "bun:test";
import { crossTurnLine, sessionTurnLine } from "./turns";

describe("turns rows", () => {
  test("cross-session row shows session, project and a one-line text", () => {
    const line = crossTurnLine(
      {
        sessionId: "abcdef1234567890",
        cwd: "/home/me/proj",
        role: "user",
        timestamp: "2026-08-20T14:03:11.000Z",
        text: "first\n\nsecond   line",
      },
      40,
    );
    expect(line.startsWith("abcdef12 ")).toBe(true);
    expect(line).toContain("proj");
    expect(line).toContain("first second line");
    expect(line).not.toContain("\n");
  });

  test("session row folds tool uses into the text and truncates", () => {
    const line = sessionTurnLine(
      {
        role: "assistant",
        timestamp: "2026-08-20T14:03:11.000Z",
        text: "x".repeat(100),
        toolUses: [{ name: "Bash" }],
      },
      3,
      30,
    );
    expect(line.startsWith("#3 ")).toBe(true);
    expect(line).toContain("…");
  });
});

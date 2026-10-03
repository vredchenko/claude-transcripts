import { describe, expect, test } from "bun:test";
import { crossTurnLine } from "./turns";

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
    expect(line.startsWith("abcdef1234567890 ")).toBe(true);
    expect(line).toContain("proj");
    expect(line).toContain("first second line");
    expect(line).not.toContain("\n");
  });
});

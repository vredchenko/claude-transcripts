/**
 * `search`'s row rendering.
 *
 * The case worth guarding is the highlight delimiters. Snippets arrive from the
 * index wrapped in U+E000/U+E001 — private-use codepoints chosen precisely because
 * nothing renders them, which is also why leaking one into a terminal is invisible
 * in review and looks like a corrupted byte to whoever hits it. The other cases are
 * the ones that make a table stop being a table: an embedded newline, and a snippet
 * longer than its column.
 */

import { describe, expect, test } from "bun:test";
import { HIGHLIGHT_POST, HIGHLIGHT_PRE } from "@claude-transcripts/shared";
import type { SearchHit, TurnHit } from "../api/generated";
import { hitLine, turnLine } from "./search";

function turn(over: Partial<TurnHit> = {}): TurnHit {
  return {
    sessionId: "abcdef1234567890",
    role: "assistant",
    snippet: "nothing special",
    timestamp: "2026-08-20T14:03:11.000Z",
    ...over,
  };
}

function hit(over: Partial<SearchHit> = {}): SearchHit {
  return { sessionId: "abcdef1234567890", timestamp: "2026-08-20T14:03:11.000Z", ...over };
}

describe("turnLine", () => {
  test("strips the index's highlight delimiters", () => {
    const snippet = `the ${HIGHLIGHT_PRE}retry${HIGHLIGHT_POST} policy backs off`;
    const line = turnLine(turn({ snippet }), 60);
    expect(line).toContain("the retry policy backs off");
    expect(line).not.toContain(HIGHLIGHT_PRE);
    expect(line).not.toContain(HIGHLIGHT_POST);
  });

  test("drops a stray closer from a snippet cropped mid-span", () => {
    const line = turnLine(turn({ snippet: `cropped${HIGHLIGHT_POST} tail` }), 60);
    expect(line).not.toContain(HIGHLIGHT_POST);
    expect(line).toContain("cropped tail");
  });

  test("collapses newlines so one turn stays one row", () => {
    const line = turnLine(turn({ snippet: "first line\n\nsecond   line" }), 60);
    expect(line).not.toContain("\n");
    expect(line).toContain("first line second line");
  });

  test("truncates to the column width with an ellipsis", () => {
    const line = turnLine(turn({ snippet: "x".repeat(200) }), 50);
    expect(line).toContain("…");
    // session(8) + when(16) + role(11) + gaps(6) = 41, then the 50-wide column.
    expect(line.length).toBeLessThanOrEqual(91);
  });

  test("renders a missing timestamp rather than 'undefined'", () => {
    const line = turnLine(turn({ timestamp: undefined }), 60);
    expect(line).not.toContain("undefined");
    expect(line).toContain("—");
  });

  test("shortens the session id to its first 8 characters", () => {
    expect(turnLine(turn(), 60).startsWith("abcdef12 ")).toBe(true);
  });
});

describe("hitLine", () => {
  test("shows which fields the query matched", () => {
    expect(hitLine(hit({ matchedIn: ["cwd", "model"] }))).toContain("cwd, model");
  });

  test("renders an em dash when the index reported no matched fields", () => {
    const line = hitLine(hit({ matchedIn: [] }));
    expect(line).not.toContain("undefined");
    expect(line.trimEnd().endsWith("—")).toBe(true);
  });

  test("renders the project name, not the whole path", () => {
    const line = hitLine(hit({ cwd: "/home/someone/dev/repos/my-project" }));
    expect(line).toContain("my-project");
    expect(line).not.toContain("/home/someone");
  });
});

/**
 * `search`'s row rendering.
 *
 * The case worth guarding is the highlight delimiters. Snippets arrive from the
 * index wrapped in U+E000/U+E001 — private-use codepoints chosen precisely because
 * nothing renders them, which is also why leaking one into a terminal is invisible
 * in review and looks like a corrupted byte to whoever hits it. The other cases are
 * the ones that make a row stop being usable: an embedded newline, and a truncated id.
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

  test("collapses newlines so one turn stays one row", () => {
    const line = turnLine(turn({ snippet: "first line\n\nsecond   line" }), 60);
    expect(line).not.toContain("\n");
    expect(line).toContain("first line second line");
  });

  test("renders a missing timestamp rather than 'undefined'", () => {
    const line = turnLine(turn({ timestamp: undefined }), 60);
    expect(line).not.toContain("undefined");
    expect(line).toContain("—");
  });

  // `sessions <id>` is an exact lookup, so the id shown must be the id (#146).
  test("prints the whole session id, so it can be passed back to `sessions`", () => {
    const id = "0f8c2a4e-1b3d-4c5e-9f60-718293a4b5c6";
    expect(turnLine(turn({ sessionId: id }), 60).startsWith(`${id}  `)).toBe(true);
    expect(hitLine(hit({ sessionId: id })).startsWith(`${id}  `)).toBe(true);
  });
});

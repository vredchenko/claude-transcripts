import { describe, expect, test } from "bun:test";
import { HIGHLIGHT_POST, HIGHLIGHT_PRE } from "@claude-transcripts/shared";
import { matchedAttributes } from "./search";

const mark = (s: string) => `${HIGHLIGHT_PRE}${s}${HIGHLIGHT_POST}`;

describe("matchedAttributes", () => {
  test("a hit on both model fields is reported once, as model", () => {
    expect(
      matchedAttributes({ model: mark("opus"), models: [mark("opus"), "sonnet"], cwd: "/p" }),
    ).toEqual(["model"]);
  });

  test("a hit only on a switched-to model still reads as model", () => {
    expect(matchedAttributes({ model: "opus", models: ["opus", mark("sonnet")] })).toEqual([
      "model",
    ]);
  });

  test("an unmarked field is not a match", () => {
    expect(matchedAttributes({ model: "opus", cwd: "/p", tools: ["Bash"] })).toEqual([]);
  });
});

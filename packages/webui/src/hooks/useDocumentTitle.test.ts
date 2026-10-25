import { describe, expect, test } from "bun:test";
import { pageTitle } from "./useDocumentTitle";

describe("pageTitle", () => {
  test("puts the page before the app", () => {
    expect(pageTitle("atlas 11111111", "Claude Transcripts")).toBe(
      "atlas 11111111 · Claude Transcripts",
    );
  });

  test("is just the app without a page", () => {
    expect(pageTitle(undefined, "Claude Transcripts")).toBe("Claude Transcripts");
  });
});

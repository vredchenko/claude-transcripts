import { describe, expect, it } from "bun:test";
import {
  HIGHLIGHT_POST,
  HIGHLIGHT_PRE,
  matchesQuery,
  splitByTerms,
  splitMarkedText,
} from "./highlight";

/** Wrap `text` the way the search index marks a matched span. */
const mark = (text: string) => `${HIGHLIGHT_PRE}${text}${HIGHLIGHT_POST}`;

/** Segments as `"plain[matched]plain"`, so an expectation reads like the output. */
function render(segments: { text: string; match: boolean }[]): string {
  return segments.map((s) => (s.match ? `[${s.text}]` : s.text)).join("");
}

describe("splitMarkedText", () => {
  it("splits a marked snippet into plain and matched runs", () => {
    expect(render(splitMarkedText(`add a ${mark("retry")} policy`))).toBe("add a [retry] policy");
  });

  it("treats an unmarked snippet as one plain run", () => {
    // What an index that isn't configured to highlight returns.
    expect(splitMarkedText("nothing marked here")).toEqual([
      { text: "nothing marked here", match: false },
    ]);
  });

  it("keeps the tail of a span that was cropped mid-match", () => {
    // Meilisearch crops to a window, which can cut between the marks.
    expect(render(splitMarkedText(`a ${HIGHLIGHT_PRE}retry`))).toBe("a [retry]");
  });

  it("drops a stray closing mark rather than emitting it", () => {
    expect(render(splitMarkedText(`plain${HIGHLIGHT_POST} text`))).toBe("plain text");
  });

  it("merges adjacent runs of the same kind", () => {
    // Two marked spans with nothing between them are one visible run.
    expect(splitMarkedText(`${mark("re")}${mark("try")}`)).toEqual([
      { text: "retry", match: true },
    ]);
  });

  it("does not treat text that merely contains markup as marked", () => {
    // The reason the marks aren't <em>: transcripts contain arbitrary markup, and it
    // must survive as literal text rather than being read as a highlight.
    const text = "<em>not a highlight</em>";
    expect(splitMarkedText(text)).toEqual([{ text, match: false }]);
  });
});

describe("splitByTerms", () => {
  it("finds a term regardless of case", () => {
    expect(render(splitByTerms("Retry the request", "retry"))).toBe("[Retry] the request");
  });

  it("finds every term of a multi-word query independently", () => {
    // Not a phrase search: the words are found wherever they appear.
    expect(render(splitByTerms("the retry policy is a policy", "retry policy"))).toBe(
      "the [retry] [policy] is a [policy]",
    );
  });

  it("prefers the longest term when two overlap", () => {
    expect(render(splitByTerms("retrying", "retry retrying"))).toBe("[retrying]");
  });

  it("treats regex metacharacters as literal text", () => {
    // A query is typed by a person; `a.b` must not match `axb`.
    expect(render(splitByTerms("a.b and axb", "a.b"))).toBe("[a.b] and axb");
  });

  it("returns the text unmarked for an empty query", () => {
    expect(splitByTerms("some text", "   ")).toEqual([{ text: "some text", match: false }]);
  });
});

describe("matchesQuery", () => {
  it("is true when any term appears, false otherwise or when either side is empty", () => {
    expect(matchesQuery("the retry policy", "backoff retry")).toBe(true);
    expect(matchesQuery("the retry policy", "backoff")).toBe(false);
    expect(matchesQuery("the retry policy", "")).toBe(false);
    expect(matchesQuery("", "retry")).toBe(false);
  });
});

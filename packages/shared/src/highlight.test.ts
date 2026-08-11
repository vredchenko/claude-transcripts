import { describe, expect, it } from "bun:test";
import {
  HIGHLIGHT_POST,
  HIGHLIGHT_PRE,
  matchesQuery,
  splitByTerms,
  splitMarkedText,
  stripHighlightMarks,
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

  it("handles several marks in one snippet", () => {
    const marked = `${mark("retry")} the ${mark("retry")} loop`;
    expect(render(splitMarkedText(marked))).toBe("[retry] the [retry] loop");
  });

  it("treats an unmarked snippet as one plain run", () => {
    // What an index that isn't configured to highlight returns.
    expect(splitMarkedText("nothing marked here")).toEqual([
      { text: "nothing marked here", match: false },
    ]);
  });

  it("returns nothing for an empty snippet", () => {
    expect(splitMarkedText("")).toEqual([]);
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

describe("stripHighlightMarks", () => {
  it("removes both marks", () => {
    expect(stripHighlightMarks(`a ${mark("retry")} policy`)).toBe("a retry policy");
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

  it("matches inside a word", () => {
    // Cruder than the index on purpose — see the note on splitByTerms.
    expect(render(splitByTerms("retrying now", "retry"))).toBe("[retry]ing now");
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

  it("returns nothing for empty text", () => {
    expect(splitByTerms("", "retry")).toEqual([]);
  });

  it("marks a whole string that is entirely a match", () => {
    expect(splitByTerms("retry", "retry")).toEqual([{ text: "retry", match: true }]);
  });
});

describe("matchesQuery", () => {
  it("is true when any term appears", () => {
    expect(matchesQuery("the retry policy", "retry")).toBe(true);
    expect(matchesQuery("the retry policy", "backoff retry")).toBe(true);
  });

  it("is false when no term appears", () => {
    expect(matchesQuery("the retry policy", "backoff")).toBe(false);
  });

  it("is false for an empty query or empty text", () => {
    expect(matchesQuery("the retry policy", "")).toBe(false);
    expect(matchesQuery("", "retry")).toBe(false);
  });
});

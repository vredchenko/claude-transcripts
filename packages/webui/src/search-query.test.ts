import { describe, expect, test } from "bun:test";
import { pageCount, pageNumber, toSearchParams } from "./search-query";

describe("pageNumber", () => {
  test("defaults to 1 and ignores junk", () => {
    expect(pageNumber({})).toBe(1);
    expect(pageNumber({ page: 0 })).toBe(1);
    expect(pageNumber({ page: -3 })).toBe(1);
    expect(pageNumber({ page: Number.NaN })).toBe(1);
    expect(pageNumber({ page: 4 })).toBe(4);
  });
});

describe("toSearchParams", () => {
  test("page 1 starts at offset 0", () => {
    expect(toSearchParams({ q: "x" }, 20)).toMatchObject({ q: "x", limit: 20, offset: 0 });
  });

  test("offset advances by a full page, not a page minus one", () => {
    // The off-by-one that would silently repeat or skip a row.
    expect(toSearchParams({ q: "x", page: 2 }, 20).offset).toBe(20);
    expect(toSearchParams({ q: "x", page: 3 }, 20).offset).toBe(40);
  });

  test("trims the query", () => {
    expect(toSearchParams({ q: "  spaced  " }).q).toBe("spaced");
  });

  test("carries only the filters that are set", () => {
    const p = toSearchParams({ q: "x", model: "claude-opus-5", cwd: "" });
    expect(p.model).toBe("claude-opus-5");
    // Empty filters are omitted, not sent blank — they're part of the cache key.
    expect("cwd" in p).toBe(false);
    expect("hostname" in p).toBe(false);
  });
});

describe("pageCount", () => {
  test("follows whichever index has more matches", () => {
    // Stopping at the shorter one would strand the tail of the longer.
    expect(pageCount({ sessions: 5, turns: 100 }, 20)).toBe(5);
    expect(pageCount({ sessions: 100, turns: 5 }, 20)).toBe(5);
  });

  test("rounds up a partial page", () => {
    expect(pageCount({ sessions: 21, turns: 0 }, 20)).toBe(2);
    expect(pageCount({ sessions: 40, turns: 0 }, 20)).toBe(2);
    expect(pageCount({ sessions: 41, turns: 0 }, 20)).toBe(3);
  });

  test("never returns zero — the pager must not render a zero-page control", () => {
    expect(pageCount({ sessions: 0, turns: 0 }, 20)).toBe(1);
  });
});

import { describe, expect, test } from "bun:test";
import { stripTrailingSlashes } from "./strings";

describe("stripTrailingSlashes", () => {
  test.each([
    ["http://x/", "http://x"],
    ["http://x///", "http://x"],
    ["/a/b", "/a/b"],
    ["/", ""],
    ["", ""],
    ["a//b//", "a//b"],
  ])("%p → %p", (input, want) => expect(stripTrailingSlashes(input)).toBe(want));

  test("a long run of slashes not at the end is linear, not quadratic", () => {
    const evil = `${"/".repeat(200_000)}x`;
    const t = performance.now();
    expect(stripTrailingSlashes(evil)).toBe(evil);
    expect(performance.now() - t).toBeLessThan(50);
  });
});

import { describe, expect, test } from "bun:test";
import { isExcluded } from "./recall";

describe("isExcluded", () => {
  test("matches a cwd against the configured globs", () => {
    expect(isExcluded("/home/me/secret/proj", ["/home/me/secret/**"])).toBe(true);
    expect(isExcluded("/home/me/proj", ["/home/me/secret/**"])).toBe(false);
  });
  test("an empty list excludes nothing", () => {
    expect(isExcluded("/anything", [])).toBe(false);
  });
});

import { describe, expect, test } from "bun:test";
import { VERIFIED_HOOK_SPEC } from "@claude-transcripts/shared";
import { type CompatDeps, hookCompatLines } from "./compat";

function deps(version: string | null, known: boolean) {
  const fetched: string[] = [];
  const d: CompatDeps = {
    version: () => version,
    spec: () => (known ? VERIFIED_HOOK_SPEC : null),
    fetch: (v) => {
      fetched.push(v);
      return true;
    },
  };
  return { d, fetched };
}

describe("hookCompatLines", () => {
  test("a known version is checked without fetching", () => {
    const { d, fetched } = deps(VERIFIED_HOOK_SPEC.claudeCode, true);
    expect(hookCompatLines(d).length).toBeGreaterThan(0);
    expect(fetched).toEqual([]);
  });

  test("an unknown version starts a background fetch and says the result comes next time", () => {
    const { d, fetched } = deps("99.0.0", false);
    expect(hookCompatLines(d)[0]).toContain("the result shows next session");
    expect(fetched).toEqual(["99.0.0"]);
  });

  test("no answer from `claude --version` is one line, not silence", () => {
    const { d } = deps(null, false);
    expect(hookCompatLines(d)).toEqual([
      "? Hook spec not checked — `claude --version` gave no answer",
    ]);
  });

  test("never throws", () => {
    const d: CompatDeps = {
      version: () => {
        throw new Error("boom");
      },
      spec: () => null,
      fetch: () => false,
    };
    expect(hookCompatLines(d)).toEqual([]);
  });
});

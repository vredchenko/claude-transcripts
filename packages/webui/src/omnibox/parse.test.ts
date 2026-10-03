import { describe, expect, it } from "bun:test";
import { type OmniboxMode, parseOmniboxInput } from "./parse";

const NOW = new Date(2026, 7, 27, 14, 30); // 27 Aug 2026, 14:30

describe("parseOmniboxInput", () => {
  it.each([
    ["hello world", "text"],
    ["", "text"],
    ["abc", "text"], // too short to be an id prefix
    [">open fauxton", "command"],
    ["abcd1234", "id"],
    ["project:foo host:bar", "operator"],
    ["today", "date"],
    ["tod", "date"], // a partial phrase still offers dates
    ["last week", "date"],
    ["aug 19", "date"],
    ["19 aug", "date"],
  ] as [string, OmniboxMode][])("%p is %s mode", (input, mode) => {
    expect(parseOmniboxInput(input, NOW).mode).toBe(mode);
  });

  it("splits operators into key, op and value", () => {
    const { operators } = parseOmniboxInput("project:foo errors:>0", NOW);
    expect(operators?.map((o) => [o.key, o.op, o.value])).toEqual([
      ["project", ":", "foo"],
      ["errors", ":>", "0"],
    ]);
  });
});

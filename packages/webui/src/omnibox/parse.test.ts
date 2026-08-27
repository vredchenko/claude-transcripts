import { describe, expect, it } from "bun:test";
import { parseOmniboxInput } from "./parse";

const NOW = new Date(2026, 7, 27, 14, 30); // 27 Aug 2026, 14:30

describe("parseOmniboxInput", () => {
  it("returns text mode for plain words", () => {
    const result = parseOmniboxInput("hello world", NOW);
    expect(result.mode).toBe("text");
    expect(result.text).toBe("hello world");
  });

  it("returns text mode for empty input", () => {
    const result = parseOmniboxInput("", NOW);
    expect(result.mode).toBe("text");
    expect(result.text).toBe("");
  });

  it("detects command mode with > prefix", () => {
    const result = parseOmniboxInput(">theme dark", NOW);
    expect(result.mode).toBe("command");
    expect(result.command).toBe("theme dark");
  });

  it("detects id mode for 4+ hex chars", () => {
    const result = parseOmniboxInput("abcd1234", NOW);
    expect(result.mode).toBe("id");
    expect(result.idPrefix).toBe("abcd1234");
  });

  it("does not treat short hex as id", () => {
    const result = parseOmniboxInput("abc", NOW);
    expect(result.mode).toBe("text");
  });

  it("detects operator mode for key:value", () => {
    const result = parseOmniboxInput("project:foo", NOW);
    expect(result.mode).toBe("operator");
    expect(result.operators).toHaveLength(1);
    expect(result.operators![0]!.key).toBe("project");
    expect(result.operators![0]!.value).toBe("foo");
  });

  it("detects operator mode for numeric operators", () => {
    const result = parseOmniboxInput("errors:>0", NOW);
    expect(result.mode).toBe("operator");
    expect(result.operators![0]!.op).toBe(":>");
  });

  it("detects date mode for 'today'", () => {
    const result = parseOmniboxInput("today", NOW);
    expect(result.mode).toBe("date");
    expect(result.dateRange).toBeDefined();
    expect(result.dateRange!.from).toContain("2026");
  });

  it("detects date mode for 'yesterday'", () => {
    const result = parseOmniboxInput("yesterday", NOW);
    expect(result.mode).toBe("date");
    expect(result.dateRange).toBeDefined();
  });

  it("detects date mode for 'last week'", () => {
    const result = parseOmniboxInput("last week", NOW);
    expect(result.mode).toBe("date");
    expect(result.dateRange).toBeDefined();
  });

  it("detects date mode for 'this month'", () => {
    const result = parseOmniboxInput("this month", NOW);
    expect(result.mode).toBe("date");
    expect(result.dateRange).toBeDefined();
  });

  it("detects date mode for 'aug 19'", () => {
    const result = parseOmniboxInput("aug 19", NOW);
    expect(result.mode).toBe("date");
    expect(result.dateRange).toBeDefined();
  });

  it("detects date mode for '19 aug'", () => {
    const result = parseOmniboxInput("19 aug", NOW);
    expect(result.mode).toBe("date");
    expect(result.dateRange).toBeDefined();
  });

  it("detects partial date phrases", () => {
    const result = parseOmniboxInput("tod", NOW);
    expect(result.mode).toBe("date");
  });

  it("handles multiple operator tokens", () => {
    const result = parseOmniboxInput("project:foo host:bar", NOW);
    expect(result.mode).toBe("operator");
    expect(result.operators).toHaveLength(2);
  });
});

/**
 * The CLI spec is data that four consumers project from, so its shape is worth
 * pinning: a command in no group vanishes from help, a `default` outside `choices`
 * documents an invocation the validator would reject.
 */
import { describe, expect, test } from "bun:test";
import { CLI_SPEC } from "./cli";
import { cliCommandsByGroup, cliUsage, toCliDocs, validateCliArgs } from "./cli-project";
import type { CliCommandDef } from "./types";

const cmd = (name: string): CliCommandDef => {
  const c = CLI_SPEC.commands.find((c) => c.name === name);
  if (!c) throw new Error(`no such command in CLI_SPEC: ${name}`);
  return c;
};

describe("CLI_SPEC", () => {
  test("command names are unique", () => {
    const names = CLI_SPEC.commands.map((c) => c.name);
    expect(new Set(names).size).toBe(names.length);
  });

  test("every command belongs to a declared group, and every group is used", () => {
    const keys = new Set(CLI_SPEC.groups.map((g) => g.key));
    for (const c of CLI_SPEC.commands) expect(keys.has(c.group)).toBe(true);
    const grouped = cliCommandsByGroup(CLI_SPEC).flatMap((g) => g.commands);
    expect(grouped.length).toBe(CLI_SPEC.commands.length);
    expect(cliCommandsByGroup(CLI_SPEC).length).toBe(CLI_SPEC.groups.length);
  });

  test("choices are non-empty and defaults are among them", () => {
    for (const c of CLI_SPEC.commands) {
      for (const a of c.args ?? []) {
        if (a.choices) expect(a.choices.length).toBeGreaterThan(0);
        if (a.choices && a.default !== undefined) expect(a.choices).toContain(String(a.default));
      }
    }
  });

  test("global flags are not duplicated per command", () => {
    const globals = new Set(CLI_SPEC.globalArgs.map((a) => a.name));
    for (const c of CLI_SPEC.commands) {
      for (const a of c.args ?? []) expect(globals.has(a.name)).toBe(false);
    }
  });

  test("usage puts required positionals in angle brackets", () => {
    expect(cliUsage(cmd("export"))).toBe("export <dir> [options]");
    expect(cliUsage(cmd("sessions"))).toBe("sessions [id] [options]");
    expect(cliUsage(cmd("provision"))).toBe("provision");
  });
});

describe("validateCliArgs", () => {
  const v = (name: string, positionals: string[], options: Record<string, string | boolean>) =>
    validateCliArgs(CLI_SPEC, cmd(name), { positionals, options });

  test("accepts a well-formed invocation", () => {
    expect(v("sessions", ["abc"], { limit: "10", webapi: "http://x" })).toEqual([]);
    expect(v("stack", ["logs", "couchdb"], { app: true })).toEqual([]);
  });

  test("rejects a value outside choices", () => {
    expect(v("stack", ["blah"], {})).toEqual([
      '<action> must be one of up | down | restart | logs | ps (got "blah")',
    ]);
  });

  test("rejects a non-number and an unknown flag, reporting both", () => {
    expect(v("sessions", [], { limit: "abc", bogus: true })).toEqual([
      '--limit must be a number (got "abc")',
      "unknown option --bogus",
    ]);
  });

  test("rejects a valued flag given bare, and a boolean flag given a value", () => {
    expect(v("sessions", [], { limit: true })).toEqual(["--limit needs a value"]);
    expect(v("backfill", [], { force: "yes" })).toEqual(['--force takes no value (got "yes")']);
  });

  test("reports a missing required positional", () => {
    expect(v("export", [], {})).toEqual(["missing required argument <dir>"]);
    expect(v("search", [], {})).toEqual(["missing required argument <query>"]);
  });
});

describe("toCliDocs", () => {
  const md = toCliDocs(CLI_SPEC, "claude-transcripts");

  test("has a table per group and a section per command", () => {
    for (const g of CLI_SPEC.groups) expect(md).toContain(`**${g.title}**`);
    for (const c of CLI_SPEC.commands) expect(md).toContain(`### \`${cliUsage(c)}\``);
  });

  test("escapes pipes so choices don't break the tables", () => {
    expect(md).toContain("up \\| down \\| restart \\| logs \\| ps");
  });
});

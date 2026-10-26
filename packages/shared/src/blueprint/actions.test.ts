import { expect, test } from "bun:test";
import { ACTIONS, followerCliArgs } from "./actions";
import { CLI_SPEC } from "./cli";
import { validateCliArgs } from "./cli-project";

test("every action's CLI trigger names a CLI_SPEC command", () => {
  const commands = new Set(CLI_SPEC.commands.map((c) => c.name));
  const bad = ACTIONS.filter((a) => a.triggers?.cli && !commands.has(a.triggers.cli));
  expect(bad.map((a) => a.key)).toEqual([]);
});

test("a follower trigger runs the action's CLI command, so it needs one", () => {
  const bad = ACTIONS.filter((a) => a.triggers?.follower && !a.triggers.cli);
  expect(bad.map((a) => a.key)).toEqual([]);
});

test("the follower's invocation of each action passes the CLI's own validation", () => {
  for (const action of ACTIONS) {
    const argv = followerCliArgs(action, ["s-1", "s-2"], "http://127.0.0.1:7650");
    if (!argv) continue;
    const [name, ...rest] = argv;
    const cmd = CLI_SPEC.commands.find((c) => c.name === name)!;
    const options: Record<string, string | boolean> = {};
    const positionals: string[] = [];
    for (let i = 0; i < rest.length; i++) {
      const a = rest[i]!;
      if (!a.startsWith("--")) positionals.push(a);
      else if (rest[i + 1] && !rest[i + 1]!.startsWith("--")) options[a.slice(2)] = rest[++i]!;
      else options[a.slice(2)] = true;
    }
    expect(validateCliArgs(CLI_SPEC, cmd, { positionals, options })).toEqual([]);
  }
});

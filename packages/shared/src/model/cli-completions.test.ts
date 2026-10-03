/**
 * Completion scripts are generated text in three shell languages, so two kinds of
 * check: a snapshot per shell (a spec edit shows up as a reviewable diff), and — where
 * the shell is installed — running the script, because a snapshot happily pins a
 * script that doesn't parse.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLI_SPEC } from "./cli";
import { COMPLETION_SHELLS, toCompletions } from "./cli-project";

const BIN = "claude-transcripts";
const dir = mkdtempSync(join(tmpdir(), "ct-completions-"));
const scriptFor = (shell: (typeof COMPLETION_SHELLS)[number]) => {
  const path = join(dir, `completions.${shell}`);
  writeFileSync(path, toCompletions(CLI_SPEC, shell, BIN));
  return path;
};
const has = (bin: string) => Bun.which(bin) !== null;

describe("toCompletions", () => {
  for (const shell of COMPLETION_SHELLS) {
    test(`${shell} script matches its snapshot`, () => {
      expect(toCompletions(CLI_SPEC, shell, BIN)).toMatchSnapshot();
    });

    test.skipIf(!has(shell))(`${shell} script parses`, () => {
      const r = Bun.spawnSync([shell, "-n", scriptFor(shell)]);
      expect(r.stderr.toString()).toBe("");
      expect(r.exitCode).toBe(0);
    });
  }

  test("every command and every flag appears in every shell's script", () => {
    for (const shell of COMPLETION_SHELLS) {
      const script = toCompletions(CLI_SPEC, shell, BIN);
      for (const c of CLI_SPEC.commands) {
        expect(script).toContain(c.name);
        for (const a of c.args ?? []) {
          if (a.name.startsWith("--"))
            expect(script).toContain(shell === "fish" ? `-l ${a.name.slice(2)}` : a.name);
        }
      }
    }
  });
});

describe.skipIf(!has("bash"))("bash completion, run", () => {
  const script = scriptFor("bash");
  /** What `<TAB>` offers after `words` (the last one is the word being completed). */
  const complete = (...words: string[]): string[] => {
    const quoted = words.map((w) => `'${w.replace(/'/g, "'\\''")}'`).join(" ");
    const r = Bun.spawnSync([
      "bash",
      "-c",
      `source '${script}'; COMP_WORDS=(${BIN} ${quoted}); COMP_CWORD=$((\${#COMP_WORDS[@]} - 1)); _claude_transcripts; printf '%s\\n' "\${COMPREPLY[@]}"`,
    ]);
    return r.stdout.toString().split("\n").filter(Boolean);
  };

  test("completes command names, and only global flags before a command", () => {
    expect(complete("st")).toEqual(["stack", "statusline"]);
    expect(complete("--")).toEqual(["--webapi", "--help", "--version"]);
  });

  test("completes a positional's choices, skipping valued flags and their values", () => {
    expect(complete("stack", "")).toEqual(["up", "down", "restart", "logs", "ps"]);
    expect(complete("--webapi", "http://x", "stack", "")).toEqual([
      "up",
      "down",
      "restart",
      "logs",
      "ps",
    ]);
    expect(complete("stack", "--app", "")).toEqual(["up", "down", "restart", "logs", "ps"]);
    expect(complete("stack", "up", "")).toEqual([]);
  });

  test("a valued flag completes to its choices, else to nothing", () => {
    expect(complete("turns", "--role", "a")).toEqual(["assistant"]);
    expect(complete("turns", "--role", "=", "")).toHaveLength(5);
    expect(complete("turns", "--limit", "")).toEqual([]);
  });

  test("offers the command's flags plus the global ones", () => {
    expect(complete("hook", "install", "--")).toEqual([
      "--dry-run",
      "--force",
      "--webapi",
      "--help",
      "--version",
    ]);
  });
});

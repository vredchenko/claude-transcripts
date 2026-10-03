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

test("the bash script avoids bash 4+ features (macOS still ships bash 3.2)", () => {
  const script = toCompletions(CLI_SPEC, "bash", BIN);
  for (const bash4 of ["mapfile", "readarray", "declare -A", "local -A", ",,}", "^^}"]) {
    expect(script).not.toContain(bash4);
  }
});

describe.skipIf(!has("bash"))("bash completion, run", () => {
  const script = scriptFor("bash");
  /** What `<TAB>` offers at the end of `line` (everything after the binary name). */
  const complete = (line: string): string[] => {
    const r = Bun.spawnSync([
      "bash",
      "-c",
      `source '${script}'; COMP_LINE="$1"; COMP_POINT=\${#1}; _claude_transcripts; printf '%s\\n' "\${COMPREPLY[@]}"`,
      "_",
      `${BIN} ${line}`,
    ]);
    return r.stdout.toString().split("\n").filter(Boolean);
  };
  const ACTIONS = ["up", "down", "restart", "logs", "ps"];

  test("completes command names, and only the boolean globals before a command", () => {
    expect(complete("st")).toEqual(["stack", "statusline"]);
    expect(complete("--")).toEqual(["--help", "--version"]);
  });

  test("only the first word is the command, as in cli.tsx", () => {
    // `--webapi x stack ps` shows help and runs nothing, so don't complete toward it.
    expect(complete("--webapi http://x st")).toEqual([]);
  });

  test("completes a positional's choices, skipping flag values the way parseFlags does", () => {
    expect(complete("stack ")).toEqual(ACTIONS);
    // A URL value: COMP_WORDS would split it at ":" and miscount what follows.
    expect(complete("stack --webapi http://x ")).toEqual(ACTIONS);
    expect(complete("stack up ")).toEqual([]);
  });

  test("after a boolean flag, offers flags only (parseFlags would take a positional as its value)", () => {
    const flags = ["--app", "--volumes", "--webapi", "--help", "--version"];
    expect(complete("stack --app ")).toEqual(flags);
    expect(complete("stack --app --volumes ")).toEqual(flags);
  });

  test("a valued flag completes to its choices, else to nothing", () => {
    expect(complete("turns --role a")).toEqual(["assistant"]);
    expect(complete("turns --role ")).toHaveLength(5);
    expect(complete("turns --limit ")).toEqual([]);
    expect(complete("turns --limit 5 --r")).toEqual(["--role"]);
  });

  test("offers the command's flags plus the global ones", () => {
    expect(complete("hook install --")).toEqual([
      "--dry-run",
      "--force",
      "--webapi",
      "--help",
      "--version",
    ]);
  });
});

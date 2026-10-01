/** The hook must start even when the session's cwd has been deleted (#171). */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hookLaunch, PLUGIN_HOOK_COMMAND } from "./hooks";

const REPO_ROOT = join(import.meta.dir, "..", "..", "..", "..");

describe("hook launch command", () => {
  test("changes to / before starting anything", () => {
    expect(hookLaunch("x hook run")).toBe("cd / && x hook run");
  });

  test("the plugin command quotes the plugin root", () => {
    expect(PLUGIN_HOOK_COMMAND).toBe('cd / && bun run "${CLAUDE_PLUGIN_ROOT}/scripts/dispatch.ts"');
  });

  test("the generated hooks.json registers exactly that command for every event", () => {
    const generated = JSON.parse(
      readFileSync(join(REPO_ROOT, "hooks", "hooks", "hooks.json"), "utf8"),
    ) as { hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>> };
    const commands = Object.values(generated.hooks).flatMap((groups) =>
      groups.flatMap((g) => g.hooks.map((h) => h.command)),
    );
    expect(commands.length).toBeGreaterThan(0);
    for (const c of commands) expect(c).toBe(PLUGIN_HOOK_COMMAND);
  });
});

/** Run `command` in a fresh /bin/sh whose cwd was deleted, as Claude Code would. */
function runFromDeletedCwd(command: string): { exitCode: number; stdout: string } {
  const dir = mkdtempSync(join(tmpdir(), "ct-gone-"));
  try {
    const proc = Bun.spawnSync(
      ["/bin/sh", "-c", 'cd "$1" && rm -rf "$1" && exec /bin/sh -c "$2"', "sh", dir, command],
      { stdout: "pipe", stderr: "pipe" },
    );
    return { exitCode: proc.exitCode ?? -1, stdout: proc.stdout.toString() };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("starting from a deleted cwd", () => {
  const bun = JSON.stringify(process.execPath);
  const script = `${bun} -e "console.log('started')"`;

  test("the launch wrapper starts it", () => {
    const res = runFromDeletedCwd(hookLaunch(script));
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("started");
  });
});

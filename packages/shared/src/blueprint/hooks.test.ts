/** The hook must start even when the session's cwd has been deleted (#171). */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hookLaunch } from "./hooks";

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

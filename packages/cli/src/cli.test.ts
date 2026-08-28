/**
 * The dispatch contract, exercised through a real process: which stream the text
 * lands on and what the exit code is. Scripts and CI steps depend on exactly this
 * (#73) — a typo must be distinguishable from a command that ran and failed.
 */
import { describe, expect, test } from "bun:test";
import { join } from "node:path";

const ENTRY = join(import.meta.dir, "cli.tsx");

async function run(...args: string[]) {
  const proc = Bun.spawn(["bun", "run", ENTRY, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
    env: { ...process.env, CT_VERSION: "1.2.3", FORCE_COLOR: "0" },
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, code };
}

describe("claude-transcripts dispatch", () => {
  test("--version prints the baked version on stdout, exit 0", async () => {
    const r = await run("--version");
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toBe("1.2.3");
    expect(r.stderr).toBe("");
  });

  test("-V works anywhere in argv", async () => {
    const r = await run("sessions", "-V");
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toBe("1.2.3");
  });

  test("no command shows grouped help on stdout, exit 0", async () => {
    const r = await run();
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("LIFECYCLE");
    expect(r.stdout).toContain("GLOBAL OPTIONS");
    expect(r.stderr).toBe("");
  });

  test("--help as the only argument is help, not an unknown command", async () => {
    const r = await run("--help");
    expect(r.code).toBe(0);
    expect(r.stdout).not.toContain("unknown command");
  });

  test("unknown command goes to stderr, exit 2, nothing on stdout", async () => {
    const r = await run("nonsense");
    expect(r.code).toBe(2);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain("unknown command: nonsense");
  });

  test("a write command's --help shows help and does not run it", async () => {
    const r = await run("backfill", "--help");
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("backfill --dry-run");
    expect(r.stdout).toContain("EXAMPLES");
    expect(r.stdout).not.toContain("backfill:");
  });

  test("a value outside choices is refused before the runner, exit 2", async () => {
    const r = await run("stack", "blah");
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("must be one of up | down | restart | logs | ps");
    expect(r.stderr).toContain("usage: claude-transcripts stack");
  });

  test("an unknown option is refused, exit 2", async () => {
    const r = await run("sessions", "--bogus");
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("unknown option --bogus");
  });
});

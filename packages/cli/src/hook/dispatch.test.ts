/**
 * The hook's stdout contract, through a real process. Two things must hold:
 *
 *   - on SessionStart with no instance configured, the hook SAYS so on stdout (the
 *     negative case plugin.md exists for), and still exits 0;
 *   - on any other event, stdout stays empty — Claude Code only reads it on a few
 *     events, and a stray line elsewhere is noise in a debug log at best.
 */
import { describe, expect, test } from "bun:test";
import { join } from "node:path";

const ENTRY = join(import.meta.dir, "..", "cli.tsx");

async function hookRun(payload: object) {
  const proc = Bun.spawn(["bun", "run", ENTRY, "hook", "run"], {
    stdout: "pipe",
    stderr: "pipe",
    stdin: new Response(JSON.stringify(payload)),
    // A config path that cannot exist → "not installed".
    env: { ...process.env, CT_HOOK_CONFIG: "/nonexistent/claude-transcripts/config.json" },
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, code };
}

describe("hook run without an instance", () => {
  test("SessionStart announces that it is not recording, exit 0", async () => {
    const r = await hookRun({
      hook_event_name: "SessionStart",
      session_id: "t1",
      source: "startup",
    });
    expect(r.code).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.systemMessage).toContain("not recording");
    expect(out.systemMessage).toContain("claude-transcripts install");
  });

  test("any other event prints nothing on stdout, exit 0", async () => {
    const r = await hookRun({
      hook_event_name: "PostToolUse",
      session_id: "t1",
      tool_name: "Bash",
    });
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("");
  });
});

/**
 * The hook's stdout contract, through a real process. Two things must hold:
 *
 *   - on SessionStart with no instance configured, the hook SAYS so on stdout (the
 *     negative case plugin.md exists for), and still exits 0;
 *   - on any other event, stdout stays empty — Claude Code only reads it on a few
 *     events, and a stray line elsewhere is noise in a debug log at best.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ENTRY = join(import.meta.dir, "..", "cli.tsx");

function writeConfig(body: unknown): string {
  const path = join(mkdtempSync(join(tmpdir(), "ct-dispatch-")), "config.json");
  writeFileSync(path, JSON.stringify(body));
  return path;
}

async function hookRun(
  payload: object,
  configPath = "/nonexistent/claude-transcripts/config.json",
) {
  const proc = Bun.spawn(["bun", "run", ENTRY, "hook", "run"], {
    stdout: "pipe",
    stderr: "pipe",
    stdin: new Response(JSON.stringify(payload)),
    // Defaults to a config path that cannot exist → "not installed".
    env: { ...process.env, CT_HOOK_CONFIG: configPath },
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

/**
 * A config the hook cannot use must not become a session it cannot run.
 *
 * `dispatch` is documented "never throws", but it built the store clients outside the
 * catch that covers the handlers — and a client constructor reads the config eagerly.
 * A config missing the store block therefore threw past every handler and out of the
 * process, taking the event with it (mirrors included).
 */
describe("hook run with an unusable config", () => {
  test("a config with no couch block exits 0 and writes nothing to stdout", async () => {
    const path = writeConfig({ features: {}, mirrors: [{ url: "https://logs.example.com" }] });
    const r = await hookRun({ hook_event_name: "PostToolUse", session_id: "t2" }, path);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("");
  });

  test("SessionStart on an unusable config still says it is not recording", async () => {
    const path = writeConfig({ features: {} });
    const r = await hookRun(
      { hook_event_name: "SessionStart", session_id: "t2", source: "startup" },
      path,
    );
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout).systemMessage).toContain("not recording");
  });

  test("a structurally broken config exits 0 rather than crashing the hook", async () => {
    const path = writeConfig({ couch: { url: "http://127.0.0.1:1" } }); // no `databases`
    const r = await hookRun({ hook_event_name: "PostToolUse", session_id: "t2" }, path);
    expect(r.code).toBe(0);
  });
});

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pluginRegistration } from "./plugin";

/** A settings path with a `plugins/` tree beside it, as Claude Code lays it out. */
function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "ct-plugin-"));
  return join(dir, "settings.json");
}

function writeInstalled(settingsPath: string, key: string, installPath: string, version: string) {
  const dir = join(settingsPath, "..", "plugins");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "installed_plugins.json"),
    JSON.stringify({ version: 2, plugins: { [key]: [{ installPath, version }] } }),
  );
}

describe("pluginRegistration", () => {
  test("no enabledPlugins → null", () => {
    expect(pluginRegistration(scratch(), {})).toBeNull();
  });

  test("another tool's plugin doesn't count", () => {
    const s = { enabledPlugins: { "warp@claude-code-warp": true } };
    expect(pluginRegistration(scratch(), s)).toBeNull();
  });

  test("installed but disabled registers nothing", () => {
    // The distinction the whole guard rests on: a disabled plugin contributes no hooks,
    // so treating "present in enabledPlugins" as enough would refuse a legitimate install.
    const s = { enabledPlugins: { "claude-transcripts@claude-transcripts": false } };
    expect(pluginRegistration(scratch(), s)).toBeNull();
  });

  test("enabled → detected, whatever marketplace it came from", () => {
    const s = { enabledPlugins: { "claude-transcripts@my-fork": true } };
    expect(pluginRegistration(scratch(), s)?.key).toBe("claude-transcripts@my-fork");
  });

  test("a plugin merely named similarly doesn't count", () => {
    const s = { enabledPlugins: { "claude-transcripts-extras@x": true } };
    expect(pluginRegistration(scratch(), s)).toBeNull();
  });

  test("version and events are read when the install is readable", () => {
    const path = scratch();
    const key = "claude-transcripts@claude-transcripts";
    const install = join(path, "..", "cache", "ct");
    mkdirSync(join(install, "hooks"), { recursive: true });
    writeFileSync(
      join(install, "hooks", "hooks.json"),
      JSON.stringify({ hooks: { SessionStart: [], PostToolUse: [], SessionEnd: [] } }),
    );
    writeInstalled(path, key, install, "0.0.16");

    const found = pluginRegistration(path, { enabledPlugins: { [key]: true } });
    expect(found?.version).toBe("0.0.16");
    expect(found?.events).toEqual(["SessionStart", "PostToolUse", "SessionEnd"]);
  });

  test("an unreadable install still reports the registration", () => {
    // Detection must not depend on the cache being intact — the registration is real
    // either way, and this is the path that decides whether `install` refuses.
    const key = "claude-transcripts@claude-transcripts";
    const found = pluginRegistration(scratch(), { enabledPlugins: { [key]: true } });
    expect(found?.key).toBe(key);
    expect(found?.events).toBeUndefined();
    expect(found?.version).toBeUndefined();
  });
});

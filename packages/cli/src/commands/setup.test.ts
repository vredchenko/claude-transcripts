/**
 * `setup`'s half of the double-registration guard.
 *
 * The detector has always been able to see the plugin (`lib/plugin.test.ts` covers
 * it); what was missing was this file asking. `hook install` refused a redundant
 * registration, `setup` did not — and `setup` is the command the docs tell you to run
 * first and the one `install` calls, so the guard sat on the door you reach for
 * second. These tests pin the wiring, not the detection.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { globalRegistrationBlockedBy } from "./setup";

/** A settings.json at a throwaway path, laid out as Claude Code would. */
function settingsWith(contents: unknown): string {
  const path = join(mkdtempSync(join(tmpdir(), "ct-setup-")), "settings.json");
  writeFileSync(path, JSON.stringify(contents));
  return path;
}

describe("globalRegistrationBlockedBy", () => {
  test("no settings file at all → nothing blocks registration", () => {
    const missing = join(mkdtempSync(join(tmpdir(), "ct-setup-")), "settings.json");
    expect(globalRegistrationBlockedBy(missing)).toBeNull();
  });

  test("a settings file with only hooks → nothing blocks registration", () => {
    // The ordinary CLI-registered machine: `setup` must still be able to re-run.
    const path = settingsWith({ hooks: { SessionStart: [{ hooks: [{ command: "bun run x" }] }] } });
    expect(globalRegistrationBlockedBy(path)).toBeNull();
  });

  test("an enabled plugin blocks registration", () => {
    const path = settingsWith({
      enabledPlugins: { "claude-transcripts@claude-transcripts": true },
    });
    expect(globalRegistrationBlockedBy(path)?.key).toBe("claude-transcripts@claude-transcripts");
  });

  test("a disabled plugin does not block registration", () => {
    // The distinction the guard rests on: a disabled plugin contributes no hooks, so
    // treating it as blocking would refuse a legitimate install and leave the machine
    // recording nothing at all.
    const path = settingsWith({
      enabledPlugins: { "claude-transcripts@claude-transcripts": false },
    });
    expect(globalRegistrationBlockedBy(path)).toBeNull();
  });

  test("another tool's plugin does not block registration", () => {
    const path = settingsWith({ enabledPlugins: { "something-else@its-marketplace": true } });
    expect(globalRegistrationBlockedBy(path)).toBeNull();
  });

  test("malformed settings never block registration", () => {
    // Read opportunistically: an unparseable settings file is not a reason to refuse
    // to set up a machine.
    const path = join(mkdtempSync(join(tmpdir(), "ct-setup-")), "settings.json");
    writeFileSync(path, "{ not json");
    expect(globalRegistrationBlockedBy(path)).toBeNull();
  });

  test("reads enabledPlugins alongside hooks, not instead of them", () => {
    // The actual defect: `readSettings` returned only `hooks`, so `enabledPlugins` was
    // invisible to this file and a plugin-registered machine looked empty.
    const path = settingsWith({
      hooks: { SessionStart: [{ hooks: [{ command: "bun run x" }] }] },
      enabledPlugins: { "claude-transcripts@my-fork": true },
    });
    expect(globalRegistrationBlockedBy(path)?.key).toBe("claude-transcripts@my-fork");
  });
});

/**
 * Mid-session model switches and directory changes land as `event` markers carrying the
 * fields that say what changed (#296). Driven by the mock Claude Code payloads.
 */
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { HANDLERS } from "./handlers";
import { buildContext } from "./runtime";

const FIXTURES = join(import.meta.dir, "../../../../tests/mock/claude-code/hooks");

async function marker(fixture: string): Promise<Record<string, unknown>> {
  const payload = await Bun.file(join(FIXTURES, fixture)).json();
  const ctx = buildContext(payload, {
    webapi: { url: "http://127.0.0.1:9" },
    features: {},
    system: { logging: { chunk: { maxEntriesPerChunk: 200, flushIntervalMs: 15000 } } },
  });
  if (!ctx) throw new Error("no context");
  const written: Record<string, unknown>[] = [];
  ctx.writer = { ...ctx.writer, event: async (doc) => void written.push(doc) };
  await HANDLERS["write-event-marker"]?.(ctx);
  expect(written).toHaveLength(1);
  return written[0] as Record<string, unknown>;
}

describe("write-event-marker", () => {
  test("PostModelSwitch records the models, the source and the cache-write estimate", async () => {
    const doc = await marker("post-model-switch/command.json");
    expect(doc).toMatchObject({
      type: "event",
      event: "PostModelSwitch",
      from_model: "claude-opus-4-8",
      to_model: "claude-sonnet-4-8",
      requested_model: "sonnet",
      source: "command",
      estimated_cache_write_usd: 0.18,
    });
  });

  test("CwdChanged records the old and the new directory", async () => {
    const doc = await marker("cwd-changed/canonical.json");
    expect(doc).toMatchObject({
      event: "CwdChanged",
      old_cwd: "/home/USER/project/core/index.md",
      new_cwd: "/home/USER/project/src/types.json",
    });
  });

  test("PreSkillShellCommand records the command, its skill and who started it (#328)", async () => {
    const doc = await marker("pre-skill-shell-command/user.json");
    expect(doc).toMatchObject({
      event: "PreSkillShellCommand",
      shell: "Bash",
      command_name: "release-notes",
      command_source: "projectSettings",
      invoked_by: "user",
      input_preview: "git log --oneline -5",
    });
    // Not a tool call: the tool views count every event that has a `tool_name`.
    expect(doc.tool_name).toBeUndefined();
  });

  test("DirectoryAdded records the directory and how it was added", async () => {
    const doc = await marker("directory-added/slash-command.json");
    expect(doc).toMatchObject({
      event: "DirectoryAdded",
      directory: "/home/USER/other-project",
      source: "slash_command",
    });
  });
});

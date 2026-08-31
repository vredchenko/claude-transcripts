#!/usr/bin/env bun
import { join } from "node:path";
/**
 * Project the app model → the plugin's Claude Code registration.
 *
 *   bun run scripts/sync-hooks.ts
 *
 * Writes hooks/hooks/hooks.json: which events the plugin registers, and with what
 * timeout. The event → action bindings are NOT codegen'd any more — the plugin
 * delegates to the installed CLI, which reads the model directly, so the only thing
 * still needing projection is the event list itself.
 * Dev-only tooling. Re-run after changing the model's BINDINGS.
 */
import { buildAppModel } from "@claude-transcripts/shared";
import { loadConfigFile } from "./lib/config-file";

const ROOT = join(import.meta.dir, "..");
const model = buildAppModel(loadConfigFile(ROOT), process.env);

// event → action keys
const bindings: Record<string, string[]> = {};
for (const b of model.bindings) bindings[b.event] = b.actions;

// hooks.json: register every bound event, routed through the plugin's shim.
const LONG_TIMEOUT = new Set(["SessionStart", "SessionEnd"]);
// Fire-and-forget everywhere it is safe, so the writer never holds up a turn. The three
// exclusions each matter: SessionStart emits the banner and the recall primer and
// SessionEnd uploads the transcript — Claude Code discards an async hook's output and
// does not wait for it — and UserPromptSubmit is decision-shaped, where async is
// ignored. Mirrors `hookAsync` in packages/cli/src/hook/index.ts; keep the two in step.
const SYNCHRONOUS = new Set(["SessionStart", "SessionEnd", "UserPromptSubmit"]);
const command = "bun run ${CLAUDE_PLUGIN_ROOT}/scripts/dispatch.ts";
const hooks: Record<string, unknown> = {};
for (const event of Object.keys(bindings)) {
  const entry: Record<string, unknown> = {
    type: "command",
    command,
    timeout: LONG_TIMEOUT.has(event) ? 180 : 5,
  };
  if (!SYNCHRONOUS.has(event)) entry.async = true;
  hooks[event] = [{ hooks: [entry] }];
}

await Bun.write(
  join(ROOT, "hooks", "hooks", "hooks.json"),
  `${JSON.stringify({ _generated: "by scripts/sync-hooks.ts from the app model (@claude-transcripts/shared) — do not edit by hand", hooks }, null, 2)}\n`,
);

console.log(`[sync-hooks] ${Object.keys(bindings).length} events → hooks.json`);

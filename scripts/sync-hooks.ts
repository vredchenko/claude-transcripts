#!/usr/bin/env bun
import { join } from "node:path";
/**
 * Project the app model → the hook's registration + dispatch bindings.
 *
 *   bun run scripts/sync-hooks.ts
 *
 * The hook is a standalone plugin (can't import the workspace), so the model's
 * hook→action bindings are codegen'd into it:
 *   - hooks/scripts/bindings.generated.json  (event → action keys, read by dispatch)
 *   - hooks/hooks/hooks.json                 (events registered with Claude Code)
 * Dev-only tooling. Re-run after changing the model's BINDINGS.
 */
import { buildAppModel } from "@claude-transcripts/shared";
import { loadConfigFile } from "./lib/config-file";

const ROOT = join(import.meta.dir, "..");
const model = buildAppModel(loadConfigFile(ROOT), process.env);

// event → action keys
const bindings: Record<string, string[]> = {};
for (const b of model.bindings) bindings[b.event] = b.actions;

// hooks.json: register every bound event, routed through dispatch.ts.
const LONG_TIMEOUT = new Set(["SessionStart", "SessionEnd"]);
const command = "bun run ${CLAUDE_PLUGIN_ROOT}/scripts/dispatch.ts";
const hooks: Record<string, unknown> = {};
for (const event of Object.keys(bindings)) {
  hooks[event] = [
    { hooks: [{ type: "command", command, timeout: LONG_TIMEOUT.has(event) ? 180 : 5 }] },
  ];
}

await Bun.write(
  join(ROOT, "hooks", "scripts", "bindings.generated.json"),
  `${JSON.stringify(bindings, null, 2)}\n`,
);
await Bun.write(
  join(ROOT, "hooks", "hooks", "hooks.json"),
  `${JSON.stringify({ _generated: "by scripts/sync-hooks.ts from the app model (@claude-transcripts/shared) — do not edit by hand", hooks }, null, 2)}\n`,
);

console.log(
  `[sync-hooks] ${Object.keys(bindings).length} events → bindings.generated.json + hooks.json`,
);

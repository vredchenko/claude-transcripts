#!/usr/bin/env bun
/**
 * Regenerate compatibility.json — the structured Claude Code compatibility
 * definition (latestPublic + per-version supported hooks) from the external
 * source of truth (ADR 0025, docs/compatibility.md). Dev-only tooling.
 *
 *   bun run scripts/regenerate-compatibility.ts
 *
 * `earliestCompatible` / `latestCompatible` come from the (future) version test
 * automation, not from here.
 */

// TODO: scrape/query the external Claude Code source of truth (published hooks
// docs / release metadata), build the per-version hook lists, and write
// compatibility.json. Placeholder below.
const compatibility = {
  generatedAt: new Date().toISOString(),
  source: "TODO: external Claude Code source of truth",
  claudeCode: {
    latestPublic: { version: "0.0.0", hooks: [] as string[] },
    latestCompatible: { version: "0.0.0", hooks: [] as string[] },
    earliestCompatible: { version: "0.0.0", hooks: [] as string[] },
  },
};

await Bun.write("compatibility.json", `${JSON.stringify(compatibility, null, 2)}\n`);
console.log("[compat] wrote compatibility.json (placeholder — generator not yet wired)");

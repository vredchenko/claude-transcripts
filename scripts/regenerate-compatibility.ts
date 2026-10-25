#!/usr/bin/env bun
/**
 * Regenerate the Claude Code hook spec this build is verified against (ADR 0025,
 * docs/start/compatibility.md). Dev-only tooling.
 *
 *   bun run gen:compat                       # regenerate for the pinned version
 *   bun run gen:compat --latest              # move the pin to the SDK's `latest`
 *   bun run gen:compat --cc-version 2.1.310  # move the pin to this version
 *
 * The pin is the `claudeCode` field of the output file itself, so a plain run is
 * reproducible: the same npm release in, the same file out — no timestamp, nothing
 * that churns. That is what lets it sit in `gen:all`, which CI re-runs and diffs.
 *
 * The source is the `@anthropic-ai/claude-agent-sdk` release cut for that Claude Code
 * version (its `claudeCodeVersion`), read with the same code the CLI uses to fetch a
 * spec for a version this build doesn't ship.
 */
import { join } from "node:path";
import type { HookSpec } from "@claude-transcripts/shared";
import { $ } from "bun";
import { fetchHookSpec, latestClaudeCodeVersion } from "../packages/cli/src/lib/claude-code-spec";

const OUT = join(import.meta.dir, "..", "packages/shared/src/claude-code-hook-spec.json");

const args = process.argv.slice(2);
const flag = args.indexOf("--cc-version");
const pinned = ((await Bun.file(OUT).json()) as HookSpec).claudeCode;
const version = args.includes("--latest")
  ? await latestClaudeCodeVersion()
  : flag >= 0
    ? args[flag + 1]
    : pinned;
if (!version) {
  console.error("usage: regenerate-compatibility.ts [--latest | --cc-version <x.y.z>]");
  process.exit(2);
}

const spec = await fetchHookSpec(version);
await Bun.write(OUT, `${JSON.stringify(spec, null, 2)}\n`);
// Biome owns the layout (it folds the short value lists); match it, or `lint` fails.
await $`bunx biome format --write ${OUT}`.quiet();
const moved = version === pinned ? "" : ` (was ${pinned})`;
console.log(
  `[compat] Claude Code ${version}${moved} via ${spec.sdk}: ${Object.keys(spec.events).length} hook events`,
);

#!/usr/bin/env bun
import { join } from "node:path";
/**
 * Generate deploy/docker-compose.yml from the app model (services topology).
 * The compose file is a PROJECTION (toComposeObject) — generated, not hand-
 * maintained. Re-run after changing the model's SERVICES.
 *
 *   bun run scripts/gen-compose.ts   (or: bun run gen:compose)
 */
import { buildAppModel, toComposeObject } from "@claude-transcripts/shared";
import { stringify } from "yaml";
import { loadConfigFile } from "./lib/config-file";

const ROOT = join(import.meta.dir, "..");
const model = buildAppModel(loadConfigFile(ROOT), process.env);

const header = `# GENERATED from the app model (@claude-transcripts/shared) by scripts/gen-compose.ts.
# Do NOT edit by hand — run \`bun run gen:compose\` to regenerate. See docs/containers.md.
#
# Driven by the stack runner (scripts/stack.ts), which feeds the repo-root .env so
# host dev and the stack share one config. Bundled stack = no auth, localhost only.

`;

await Bun.write(
  join(ROOT, "deploy", "docker-compose.yml"),
  header + stringify(toComposeObject(model)),
);
console.log("[gen-compose] wrote deploy/docker-compose.yml");

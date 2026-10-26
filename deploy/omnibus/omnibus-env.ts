#!/usr/bin/env bun
/**
 * Print the stack env the omnibus services read, projected from the blueprint:
 * every service's port (`*_PORT`, honouring overrides already in the environment) and
 * the Fossil repositories to seed. One `KEY=value` per line.
 *
 * The compose runner gets the same values from `toComposeEnv`; this is that projection
 * for a stack with no runner, so the omnibus binds the ports the docs, the webui's
 * service links and the CLI's defaults all expect — and moves with them.
 *
 *   bun run deploy/omnibus/omnibus-env.ts
 */
import { join } from "node:path";
// By path, like scripts/mirror-images.ts: workspace packages are linked into the
// packages that depend on them, not the root, so the package name doesn't resolve here.
import { buildAppBlueprint, toComposeEnv } from "../../packages/shared/src/index";
import { loadConfigFile } from "../../scripts/lib/config-file";

const ROOT = join(import.meta.dir, "..", "..");
const model = buildAppBlueprint(loadConfigFile(ROOT), process.env);

for (const [key, value] of Object.entries(toComposeEnv(model))) {
  // Image tags are compose's business; this image's versions are fixed at build time.
  if (key.endsWith("_TAG")) continue;
  console.log(`${key}=${value}`);
}

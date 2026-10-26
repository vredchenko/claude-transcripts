#!/usr/bin/env bun
/**
 * Build the omnibus image (deploy/omnibus/) from this checkout. Dev-only tooling.
 *
 *   bun run omnibus:build [-- <extra bake args>]
 *
 * One `docker buildx bake` over deploy/omnibus/docker-bake.hcl: the app image, the
 * Fossil image and the omnibus build as one graph, in parallel, sharing a cache, and
 * the result is loaded as claude-transcripts-omnibus:local (OMNIBUS_TAG to change it).
 * Set APP_IMAGE to assemble from a published app image instead of building one.
 * Extra arguments go to bake, e.g. `--set omnibus.platform=linux/arm64`.
 */
import { join } from "node:path";
import { $ } from "bun";

const ROOT = join(import.meta.dir, "..");
const TAG = process.env.OMNIBUS_TAG ?? "claude-transcripts-omnibus:local";

await $`docker buildx bake -f deploy/omnibus/docker-bake.hcl --load ${process.argv.slice(2)} omnibus`
  .cwd(ROOT)
  .env({ ...process.env, OMNIBUS_TAG: TAG });
console.log(`[omnibus] built ${TAG} — smoke-test it with: bun run omnibus:smoke ${TAG}`);

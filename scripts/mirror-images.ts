#!/usr/bin/env bun
/**
 * Mirror the pinned third-party backing-service images into the GitHub Container Registry (GHCR)
 * under the `claude-transcripts-*` names the compose stack pulls (ADR 0024).
 * Dev-only tooling.
 *
 *   IMAGE_NS=<registry>/<org> bun run scripts/mirror-images.ts
 *
 * The image list is a PROJECTION of the app model (toMirrorPlan) — the model's
 * SERVICES is the one place image names and tags are declared, so this script can't
 * drift from what the compose stack actually pulls. Add a backing service there.
 *
 * (The app image — claude-transcripts-app — is built + published by the
 * publish-image workflow, not here: it has no `upstream`, so it isn't in the plan.)
 */
import { join } from "node:path";
import { $ } from "bun";
// Imported by path, not by package name: `bun install` links workspace packages into
// the *packages* that depend on them, not the repo root, so `@claude-transcripts/shared`
// doesn't resolve from scripts/ in a bare CI checkout. Unlike its siblings here, this
// script runs in CI (mirror-images.yml), so it can't rely on a dev's node_modules.
// shared/ is dependency-free, so importing the source directly costs nothing.
import { buildAppModel, toMirrorPlan } from "../packages/shared/src/index";
import { loadConfigFile } from "./lib/config-file";

const NS = process.env.IMAGE_NS; // e.g. ghcr.io/OWNER

const ROOT = join(import.meta.dir, "..");
const IMAGES = toMirrorPlan(buildAppModel(loadConfigFile(ROOT), process.env));

async function main() {
  if (!NS) throw new Error("IMAGE_NS is required (e.g. ghcr.io/OWNER)");
  for (const { upstream, dest } of IMAGES) {
    const target = `${NS}/${dest}`;
    console.log(`[mirror] ${upstream} → ${target}`);
    await $`docker pull ${upstream}`;
    await $`docker tag ${upstream} ${target}`;
    await $`docker push ${target}`;
  }
  console.log(`[mirror] done — ${IMAGES.length} image(s)`);
}

await main();

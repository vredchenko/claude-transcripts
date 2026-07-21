#!/usr/bin/env bun
/**
 * Release: version all components together (lockstep semver), build each
 * separately, then combine into one image (ADR 0023). Dev-only tooling; the real
 * publish runs in GitHub Actions on a `vX.Y.Z` tag.
 *
 *   bun run scripts/release.ts <version>
 */
import { $ } from "bun";

const version = process.argv[2];
if (!version || !/^\d+\.\d+\.\d+/.test(version)) {
  throw new Error("usage: release.ts <semver>  (e.g. 0.1.0)");
}

async function main() {
  console.log(`[release] versioning all components → ${version}`);
  // TODO: stamp version into package.json files + plugin.json (lockstep).
  console.log("[release] build components: webapi bundle, webui dist, cli binary");
  await $`bun run build`; // webui SPA (others wired as they land)
  // TODO: bun build --compile the CLI per target OS.
  // TODO: docker build the combined image and push to the GitHub Container Registry (GHCR).
  console.log("[release] (skeleton) component build + combined image are TODO");
}

await main();

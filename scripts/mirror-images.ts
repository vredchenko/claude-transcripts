#!/usr/bin/env bun
/**
 * Mirror the pinned third-party backing-service images into the GitHub Container Registry (GHCR)
 * under the `claude-transcripts-*` names the compose stack pulls (ADR 0024).
 * Dev-only tooling.
 *
 *   IMAGE_NS=<registry>/<org> bun run scripts/mirror-images.ts
 *
 * (The app image — claude-transcripts-app — is built + published by the
 * publish-image workflow, not here.)
 */
import { $ } from "bun";

const NS = process.env.IMAGE_NS; // e.g. ghcr.io/OWNER

// [ upstream image, destination name:tag ] — keep in lockstep with the tags in
// deploy/docker-compose.yml / .env.template.
const IMAGES: Array<[string, string]> = [
  ["couchdb:3", "claude-transcripts-couchdb:3"],
  ["dxflrs/garage:v2.3.0", "claude-transcripts-garage:v2.3.0"],
  ["khairul169/garage-webui:1.1.0", "claude-transcripts-garage-ui:1.1.0"],
  ["getmeili/meilisearch:v1.10", "claude-transcripts-meilisearch:v1.10"],
  ["riccox/meilisearch-ui:latest", "claude-transcripts-meilisearch-ui:latest"],
];

async function main() {
  if (!NS) throw new Error("IMAGE_NS is required (e.g. ghcr.io/OWNER)");
  for (const [upstream, dest] of IMAGES) {
    const target = `${NS}/${dest}`;
    console.log(`[mirror] ${upstream} → ${target}`);
    await $`docker pull ${upstream}`;
    await $`docker tag ${upstream} ${target}`;
    await $`docker push ${target}`;
  }
  console.log("[mirror] done");
}

await main();

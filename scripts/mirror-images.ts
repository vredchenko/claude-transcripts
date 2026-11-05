#!/usr/bin/env bun
/**
 * Mirror the pinned third-party backing-service images (every platform each publishes) into the GitHub Container Registry (GHCR)
 * under the `claude-transcripts-*` names the compose stack pulls (ADR 0024).
 * Dev-only tooling.
 *
 *   IMAGE_NS=<registry>/<org> bun run scripts/mirror-images.ts   # mirror + build + push all
 *   bun run scripts/mirror-images.ts --plan                     # the plan, as JSON
 *
 * CI (mirror-images.yml) uses `--plan` to run one job per image, each scanned by the
 * project's gate (.github/actions/scan-image) BEFORE it is pushed, so an image that
 * fails never reaches the registry under its tag. Run without flags, this script
 * publishes without scanning: it is the by-hand path, for a registry you check yourself.
 *
 * The image list is a PROJECTION of the blueprint (toMirrorPlan) — the blueprint's
 * SERVICES is the one place image names and tags are declared, so this script can't
 * drift from what the compose stack actually pulls. Add a backing service there.
 *
 * Backing software that publishes source but no image (Fossil) can't be mirrored, and
 * one whose image fails the scan gate (the Garage web UI) shouldn't be, so those are
 * built here from their in-repo Dockerfiles (toImageBuildPlan) and pushed under the
 * same naming — to a consumer of the registry, a built image and a mirrored one look
 * alike.
 *
 * (The app image — claude-transcripts-app — is built + published by the
 * publish-image workflow, not here: it is in neither plan.)
 */
import { join } from "node:path";
import { $ } from "bun";
// Imported by path, not by package name: `bun install` links workspace packages into
// the *packages* that depend on them, not the repo root, so `@claude-transcripts/shared`
// doesn't resolve from scripts/ in a bare CI checkout. Unlike its siblings here, this
// script runs in CI (mirror-images.yml), so it can't rely on a dev's node_modules.
// shared/ is dependency-free, so importing the source directly costs nothing.
import { buildAppBlueprint, toImageBuildPlan, toMirrorPlan } from "../packages/shared/src/index";
import { loadConfigFile } from "./lib/config-file";

const NS = process.env.IMAGE_NS; // e.g. ghcr.io/OWNER

const ROOT = join(import.meta.dir, "..");
const MODEL = buildAppBlueprint(loadConfigFile(ROOT), process.env);
const IMAGES = toMirrorPlan(MODEL);
const BUILDS = toImageBuildPlan(MODEL);

/** One entry per published backing image: copied from upstream, or built from deploy/. */
export type PlanEntry =
  | { kind: "mirror"; dest: string; upstream: string }
  | { kind: "build"; dest: string; context: string };

function plan(): PlanEntry[] {
  return [
    ...IMAGES.map((i): PlanEntry => ({ kind: "mirror", dest: i.dest, upstream: i.upstream })),
    ...BUILDS.map(
      (b): PlanEntry => ({
        kind: "build",
        dest: b.dest,
        context: `deploy/${b.context.replace(/^\.\//, "")}`,
      }),
    ),
  ];
}

async function main() {
  if (process.argv.includes("--plan")) {
    console.log(JSON.stringify(plan()));
    return;
  }
  if (!NS) throw new Error("IMAGE_NS is required (e.g. ghcr.io/OWNER)");
  for (const { upstream, dest } of IMAGES) {
    const target = `${NS}/${dest}`;
    console.log(`[mirror] ${upstream} → ${target}`);
    // Registry to registry, the whole multi-arch index: a pull/tag/push would copy only
    // the runner's platform, leaving the mirror amd64-only while upstream isn't.
    await $`docker buildx imagetools create --tag ${target} ${upstream}`;
  }
  for (const { context, dest } of BUILDS) {
    const target = `${NS}/${dest}`;
    const dir = join(ROOT, "deploy", context);
    console.log(`[mirror] build ${dir} → ${target}`);
    await $`docker build -t ${target} ${dir}`;
    await $`docker push ${target}`;
  }
  console.log(`[mirror] done — ${IMAGES.length} mirrored, ${BUILDS.length} built`);
}

await main();

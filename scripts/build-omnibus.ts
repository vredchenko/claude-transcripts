#!/usr/bin/env bun
/**
 * Build the omnibus image (deploy/omnibus/) from this checkout. Dev-only tooling.
 *
 *   bun run omnibus:build [-- <extra docker build args>]
 *
 * The omnibus assembles component images rather than rebuilding them, so this builds
 * those first — the app (root Dockerfile) and every image we build from source
 * (toImageBuildPlan: Fossil) — under the same `-local` tags the compose stack's
 * `--build` / `--upstream` paths use, then passes them in. Extra arguments go to the
 * final build only (e.g. `--platform linux/arm64`, `--build-arg OMNIBUS_GIT_REF=…`).
 */
import { join } from "node:path";
import { $ } from "bun";
import { buildAppBlueprint, toImageBuildPlan } from "../packages/shared/src/index";
import { loadConfigFile } from "./lib/config-file";

const ROOT = join(import.meta.dir, "..");
const MODEL = buildAppBlueprint(loadConfigFile(ROOT), process.env);
const TAG = process.env.OMNIBUS_TAG ?? "claude-transcripts-omnibus:local";
const VERSION = process.env.CT_VERSION ?? "0.0.0-dev";

const APP = "claude-transcripts-app:local";
console.log(`[omnibus] building ${APP}`);
await $`docker build --build-arg CT_VERSION=${VERSION} -t ${APP} ${ROOT}`;

const args: string[] = ["--build-arg", `APP_IMAGE=${APP}`];
for (const { context, dest } of toImageBuildPlan(MODEL)) {
  const local = `${dest}-local`;
  console.log(`[omnibus] building ${local}`);
  await $`docker build -t ${local} ${join(ROOT, "deploy", context)}`;
  const name = dest.slice("claude-transcripts-".length).split(":")[0] ?? "";
  args.push("--build-arg", `${name.toUpperCase().replaceAll("-", "_")}_IMAGE=${local}`);
}

console.log(`[omnibus] building ${TAG}`);
await $`docker build -f ${join(ROOT, "deploy/omnibus/Dockerfile")} ${args} ${process.argv.slice(2)} -t ${TAG} ${ROOT}`;
console.log(`[omnibus] done: docker run -d -p 127.0.0.1:7650:7650 -v ct-omnibus:/data ${TAG}`);

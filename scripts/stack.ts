#!/usr/bin/env bun
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
/**
 * Dev stack runner — wraps `docker compose` for the backing services (+ app).
 *
 *   bun run scripts/stack.ts up        [--app] [--build] [--upstream]   # start (detached)
 *   bun run scripts/stack.ts down      [--app] [--build] [--upstream]   # stop + remove
 *   bun run scripts/stack.ts restart   [--app] [--build] [--upstream]
 *   bun run scripts/stack.ts logs      [--app] [--build] [--upstream]
 *   bun run scripts/stack.ts ps        [--app] [--build] [--upstream]
 *
 * --upstream layers deploy/docker-compose.upstream.yml over the base file so the
 * backing services pull their canonical PUBLIC images — no registry mirror
 * needed (the zero-setup dev path). Without it, images come from ${IMAGE_NS}.
 *
 * --build layers deploy/docker-compose.build.yml so the combined APP image is BUILT
 * from the repo (local tag) instead of pulled from ${IMAGE_NS} — the zero-registry
 * path for the full containerised stack. It implies --app, and `up` passes --build.
 * Pair with --upstream so the backing images are public too.
 *
 * The MODEL drives compose: ports + image tags are projected from the app model
 * (toComposeEnv) and injected into the compose process, so the topology defined
 * once in @claude-transcripts/shared is authoritative. The repo-root .env still supplies
 * IMAGE_NS + secrets (and is the same file Bun auto-loads for the host-run app),
 * so host dev and the stack stay coherent.
 */
import { buildAppModel, toComposeEnv } from "@claude-transcripts/shared";
import { $ } from "bun";
import { loadConfigFile } from "./lib/config-file";

const ROOT = join(import.meta.dir, "..");
const ENV_FILE = join(ROOT, ".env");
const COMPOSE = join(ROOT, "deploy", "docker-compose.yml");
const COMPOSE_UPSTREAM = join(ROOT, "deploy", "docker-compose.upstream.yml");
const COMPOSE_BUILD = join(ROOT, "deploy", "docker-compose.build.yml");

const [cmd, ...rest] = process.argv.slice(2);
const useUpstream = rest.includes("--upstream");
const useBuild = rest.includes("--build");
// --build implies the app profile (you're building + running the app container).
const wantApp = rest.includes("--app") || useBuild;
const profileArgs = wantApp ? ["--profile", "app"] : [];
// -f order matters: later overrides win. upstream (public backing images) and build
// (local app image) both layer over the base.
const fileArgs = [
  "-f",
  COMPOSE,
  ...(useUpstream ? ["-f", COMPOSE_UPSTREAM] : []),
  ...(useBuild ? ["-f", COMPOSE_BUILD] : []),
];

// Project ports + image tags from the model (resolved against the loaded env).
const model = buildAppModel(loadConfigFile(ROOT), process.env);
const composeEnv = toComposeEnv(model);

function ensurePrereqs() {
  if (!existsSync(ENV_FILE)) {
    throw new Error(
      ".env not found — copy .env.template to .env and fill it in (IMAGE_NS, garage secrets).",
    );
  }
  if (!existsSync(join(ROOT, "config", "config.json"))) {
    console.warn(
      "[stack] config/config.json not found — using config/config.template.json defaults.",
    );
  }
  if (!useUpstream && !Bun.env.IMAGE_NS) {
    console.warn(
      "[stack] IMAGE_NS is empty and --upstream not set — images resolve to '/claude-transcripts-*'\n" +
        "        and will fail to pull. For a no-mirror dev run, add --upstream (public images).",
    );
  }
  // Pre-create the bind-mount dirs so docker doesn't create them owned by root.
  for (const d of ["couchdb", "garage/meta", "garage/data", "meilisearch"]) {
    mkdirSync(join(ROOT, "deploy", "data", d), { recursive: true });
  }
}

async function compose(args: string[]) {
  // composeEnv (model-derived ports/tags) overrides matching .env vars; .env still
  // provides IMAGE_NS + secrets via --env-file.
  await $`docker compose --env-file ${ENV_FILE} ${fileArgs} ${args}`.env({
    ...Bun.env,
    ...composeEnv,
  });
}

async function main() {
  switch (cmd) {
    case "up":
      ensurePrereqs();
      console.log(
        `[stack] model ports → ${Object.entries(composeEnv)
          .filter(([k]) => k.endsWith("_PORT"))
          .map(([k, v]) => `${k}=${v}`)
          .join(" ")}`,
      );
      await compose([...profileArgs, "up", "-d", ...(useBuild ? ["--build"] : [])]);
      break;
    case "down":
      await compose([...profileArgs, "down"]);
      break;
    case "restart":
      ensurePrereqs();
      await compose([...profileArgs, "restart"]);
      break;
    case "logs":
      await compose([...profileArgs, "logs", "-f", "--tail", "100"]);
      break;
    case "ps":
      await compose([...profileArgs, "ps"]);
      break;
    default:
      console.log(
        "usage: bun run scripts/stack.ts <up|down|restart|logs|ps> [--app] [--build] [--upstream]",
      );
      process.exit(cmd ? 1 : 0);
  }
}

await main();

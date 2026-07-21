#!/usr/bin/env bun
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
/**
 * Dev stack runner — wraps `docker compose` for the backing services (+ app).
 *
 *   bun run scripts/stack.ts up        [--app] [--upstream]   # start (detached)
 *   bun run scripts/stack.ts down      [--app] [--upstream]   # stop + remove
 *   bun run scripts/stack.ts restart   [--app] [--upstream]
 *   bun run scripts/stack.ts logs      [--app] [--upstream]
 *   bun run scripts/stack.ts ps        [--app] [--upstream]
 *
 * --upstream layers deploy/docker-compose.upstream.yml over the base file so the
 * backing services pull their canonical PUBLIC images — no registry mirror
 * needed (the zero-setup dev path). Without it, images come from ${IMAGE_NS}.
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

const [cmd, ...rest] = process.argv.slice(2);
const profileArgs = rest.includes("--app") ? ["--profile", "app"] : [];
const useUpstream = rest.includes("--upstream");
// -f order matters: the upstream override (public images) wins over the base.
const fileArgs = useUpstream ? ["-f", COMPOSE, "-f", COMPOSE_UPSTREAM] : ["-f", COMPOSE];

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
      await compose([...profileArgs, "up", "-d"]);
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
      console.log("usage: bun run scripts/stack.ts <up|down|restart|logs|ps> [--app]");
      process.exit(cmd ? 1 : 0);
  }
}

await main();

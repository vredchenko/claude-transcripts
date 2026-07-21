#!/usr/bin/env bun
import { join } from "node:path";
/**
 * Generate deploy/docker-compose.upstream.yml from the app model — the
 * UPSTREAM-IMAGE dev override (toComposeOverrideObject). For every backing/admin
 * service we mirror, it pins the canonical upstream image so a fresh clone can run
 * the stack with NO registry mirror:
 *
 *   docker compose -f deploy/docker-compose.yml -f deploy/docker-compose.upstream.yml up
 *   # or via the runner:  bun run scripts/stack.ts up --upstream
 *
 * A PROJECTION — generated, not hand-maintained. Re-run after changing SERVICES.
 *
 *   bun run scripts/gen-compose-override.ts   (or: bun run gen:compose-override)
 */
import { buildAppModel, toComposeOverrideObject } from "@claude-transcripts/shared";
import { stringify } from "yaml";
import { loadConfigFile } from "./lib/config-file";

const ROOT = join(import.meta.dir, "..");
const model = buildAppModel(loadConfigFile(ROOT), process.env);

const header = `# GENERATED from the app model (@claude-transcripts/shared) by scripts/gen-compose-override.ts.
# Do NOT edit by hand — run \`bun run gen:compose-override\` to regenerate.
#
# Upstream-image dev override: pins each mirrored backing service to its canonical
# public image so a fresh clone needs NO registry / mirror. Layer it over the
# base compose (later -f wins):
#
#   docker compose -f deploy/docker-compose.yml -f deploy/docker-compose.upstream.yml up
#   bun run scripts/stack.ts up --upstream        # the runner does this for you
#
# Tags still come from .env (COUCHDB_TAG, GARAGE_TAG, …). Override an image here by
# changing its \`upstream\` in packages/shared/src/model/services.ts. The community
# admin-UI images are best-effort; swap them if your registry differs.

`;

await Bun.write(
  join(ROOT, "deploy", "docker-compose.upstream.yml"),
  header + stringify(toComposeOverrideObject(model)),
);
console.log("[gen-compose-override] wrote deploy/docker-compose.upstream.yml");

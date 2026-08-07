#!/usr/bin/env bun
import { join } from "node:path";
/**
 * Generate deploy/docker-compose.yml from the app model (services topology).
 * The compose file is a PROJECTION (toComposeObject) — generated, not hand-
 * maintained. Re-run after changing the model's SERVICES.
 *
 *   bun run scripts/gen-compose.ts   (or: bun run gen:compose)
 */
import { buildAppModel, toComposeObject } from "@claude-transcripts/shared";
import { stringify } from "yaml";
import { loadConfigFile } from "./lib/config-file";

const ROOT = join(import.meta.dir, "..");
const model = buildAppModel(loadConfigFile(ROOT), process.env);

// Everything a reader of the generated file needs, kept HERE rather than as inline
// comments in deploy/docker-compose.yml — the generator can't reproduce those, so any
// added by hand are silently destroyed on the next `gen:compose`. That is how the
// app's `WEBAPI_PORT` pin came to be a hand-edit the generator would have dropped.
const header = `# GENERATED from the app model (@claude-transcripts/shared) by scripts/gen-compose.ts.
# Do NOT edit by hand — run \`bun run gen:compose\` to regenerate, and change the model
# (packages/shared/src/model/services.ts) instead. Inline edits here are lost silently.
# See docs/operate/containers.md.
#
# Claude Transcripts — backing services + app.
#
#   Dev    : bun run scripts/stack.ts up          → backing services only.
#                                                    Run webapi/webui/cli on the HOST.
#   Deploy : bun run scripts/stack.ts up --app    → also runs the app container.
#
# The runner reads the repo-root .env — the SAME file the host-run webapi/webui use —
# and passes it to compose, so ports, credentials and image refs are defined once and
# stay coherent across host dev and the stack. App config (names, feature flags) lives
# in config/: baked into the app image AND read by the host app.
#
# Images are PULLED from GHCR (\${IMAGE_NS}); mirror/publish them with
# scripts/mirror-images.ts (backing) and the publish-image workflow (app). The bundled
# stack runs with NO AUTH for app access (ADR 0020), localhost only; Garage's internal
# cluster secrets still come from .env. CouchDB 3 removed "admin party", so it ships a
# fixed default admin (admin/admin) — override in .env for anything exposed.
#
# The app container pins WEBAPI_PORT=7650 (its INTERNAL port) because env_file would
# otherwise hand it the host-side port and it would bind there, leaving nothing on the
# port \`ports:\` publishes.
#
# State is bind-mounted to ./data/* (deploy/data, gitignored) so it lives in-repo and is
# easy to inspect or wipe.

`;

await Bun.write(
  join(ROOT, "deploy", "docker-compose.yml"),
  header + stringify(toComposeObject(model)),
);
console.log("[gen-compose] wrote deploy/docker-compose.yml");

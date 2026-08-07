#!/usr/bin/env bun
/**
 * Regenerate the typed API clients for the CLI + webui from the webapi OpenAPI
 * spec — the contract source of truth (ADR 0019). Dev-only tooling.
 *
 *   bun run scripts/regenerate-api-clients.ts   (or: bun run gen:clients)
 *
 * Steps:
 *   1. Build the OpenAPI spec OFFLINE (no running server, no backend connections)
 *      via the webapi's write-openapi.ts → ./openapi.json.
 *   2. Run orval over orval.config.ts to emit the generated clients into
 *      packages/cli and packages/webui (single-file fetch / react-query clients).
 *   3. Format the emitted files with Biome. Orval's output doesn't match the repo's
 *      style (import order in particular), and these files are committed — so without
 *      this, `lint` fails on freshly generated code and the only fixes available are
 *      hand-editing a generated file or exempting it from the linter. Formatting here
 *      is deterministic, so regeneration reproduces byte-identical output.
 */
import { join } from "node:path";
import { $ } from "bun";

const ROOT = join(import.meta.dir, "..");
const SPEC = join(ROOT, "openapi.json");
const WRITE_OPENAPI = join(ROOT, "packages", "webapi", "src", "write-openapi.ts");

async function main() {
  // 1. Emit the spec offline (deterministic; no port, no Couch/S3).
  await $`bun run ${WRITE_OPENAPI} ${SPEC}`;
  // 2. Generate the clients (orval reads ./openapi.json per orval.config.ts).
  await $`bunx orval --config ${join(ROOT, "orval.config.ts")}`;
  // 3. Bring the emitted files up to repo style so `lint` passes on generated code.
  const targets = ["cli", "webui"].map((p) =>
    join(ROOT, "packages", p, "src", "api", "generated.ts"),
  );
  await $`bunx biome check --write ${targets}`.quiet();
  console.log("[gen] clients regenerated into packages/{cli,webui}/src/api/generated.ts");
}

await main();

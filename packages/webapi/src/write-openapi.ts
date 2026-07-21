#!/usr/bin/env bun
/**
 * Write the webapi OpenAPI document to a file (default ./openapi.json), built
 * offline (no server). Used by scripts/regenerate-api-clients.ts before orval.
 *
 *   bun run packages/webapi/src/write-openapi.ts [outPath]
 */
import { buildOpenApiDocument } from "./openapi";

const out = process.argv[2] ?? "openapi.json";
await Bun.write(out, `${JSON.stringify(buildOpenApiDocument(), null, 2)}\n`);
console.log(`[openapi] wrote ${out}`);

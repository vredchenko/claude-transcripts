/**
 * Build the webapi's OpenAPI document **offline** — no server, no backend
 * connections. `buildServer` registers the routes and attaches the generated doc
 * to `model.apiSpec`; we just need that document, not a listening server.
 *
 * This is the contract source of truth (ADR 0019) that orval generates the CLI +
 * webui clients from. Emitted to a file by write-openapi.ts and consumed by
 * scripts/regenerate-api-clients.ts (`bun run gen:clients`).
 */
import { buildAppModel } from "@claude-transcripts/shared";
import { loadAppConfigFile, loadConfig } from "./config";
import { buildServer } from "./server";
import type { BlobStore } from "./storage/blob-store";
import { makeCouch } from "./storage/couch";
import { Meili } from "./storage/meili";

// Route registration never touches the backends — only the handlers do — so a
// no-op blob store and a (lazily-constructed, never-called) couch handle suffice.
const specBlob: BlobStore = {
  async get() {
    throw new Error("spec build: not callable");
  },
  async stat() {
    return null;
  },
  async put() {
    /* no-op */
  },
};

export function buildOpenApiDocument(): unknown {
  const config = loadConfig();
  const model = buildAppModel(loadAppConfigFile(), process.env);
  // buildServer sets model.apiSpec = app.getOpenAPIDocument(...) as a side effect.
  // A disabled Meili is enough — route registration never calls it.
  const meili = new Meili({ ...config.meili, enabled: false });
  buildServer({
    config,
    couch: makeCouch(config),
    blob: specBlob,
    meili,
    model,
    // Spec generation registers routes without ever serving one, so no boot
    // provisioning happens (and /health is never called) — a stub suffices.
    boot: { startedAt: new Date().toISOString(), couchProvisioned: false },
  });
  return model.apiSpec;
}

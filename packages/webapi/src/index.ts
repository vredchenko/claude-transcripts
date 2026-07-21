/**
 * webapi entry point. Loads config, opens CouchDB + S3 handles, ensures the
 * schema, and serves the app. Bun serves the default export's `fetch`.
 */
import { buildAppModel } from "@claude-transcripts/shared";
import { loadAppConfigFile, loadConfig } from "./config";
import type { AppContext } from "./context";
import { buildServer } from "./server";
import { makeCouch } from "./storage/couch";
import { ensureCouchDbs } from "./storage/ensure";
import { S3BlobStore } from "./storage/s3-blob-store";

const config = loadConfig();
const couch = makeCouch(config);
const blob = new S3BlobStore(config);
// The app model (central state) — built once from the raw config + env, held
// in-memory, and served at `/`. Projections derive from it.
const model = buildAppModel(loadAppConfigFile(), process.env);
const ctx: AppContext = { config, couch, blob, model };

// Idempotent boot-time schema setup. Never block startup on it.
await ensureCouchDbs(couch, config).catch((err) => {
  console.error("ensureCouchDbs failed (continuing):", err);
});

const app = buildServer(ctx);

console.log(`webapi listening on http://${config.webapi.host}:${config.webapi.port}`);

export default {
  port: config.webapi.port,
  hostname: config.webapi.host,
  fetch: app.fetch,
};

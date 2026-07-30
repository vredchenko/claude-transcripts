/**
 * webapi entry point. Loads config, opens CouchDB + S3 handles, ensures the
 * schema, and serves the app. Bun serves the default export's `fetch`.
 */
import { buildAppModel } from "@claude-transcripts/shared";
import { loadAppConfigFile, loadConfig } from "./config";
import type { AppContext, BootStatus } from "./context";
import { buildServer } from "./server";
import { makeCouch } from "./storage/couch";
import { ensureCouchDbs } from "./storage/ensure";
import {
  Meili,
  SESSIONS_INDEX,
  SESSIONS_INDEX_SETTINGS,
  TURNS_INDEX,
  TURNS_INDEX_SETTINGS,
} from "./storage/meili";
import { S3BlobStore } from "./storage/s3-blob-store";
import { startSearchFollower } from "./storage/search-follower";

const config = loadConfig();
const couch = makeCouch(config);
const blob = new S3BlobStore(config);
const meili = new Meili(config.meili);
// The app model (central state) — built once from the raw config + env, held
// in-memory, and served at `/`. Projections derive from it.
const model = buildAppModel(loadAppConfigFile(), process.env);
const boot = { startedAt: new Date().toISOString(), couchProvisioned: false } as BootStatus;
const ctx: AppContext = { config, couch, blob, meili, model, boot };

// Idempotent boot-time schema setup. Never block startup on it — but record the
// outcome, so `/health` can say the stores are missing instead of reporting "ok"
// right up until the first write fails.
await ensureCouchDbs(couch, config)
  .then(() => {
    boot.couchProvisioned = true;
  })
  .catch((err) => {
    boot.error = err instanceof Error ? err.message : String(err);
    console.error("ensureCouchDbs failed (continuing):", err);
  });
// Ensure the search indexes (best-effort; no-op when Meili is disabled/unreachable).
await meili.ensureIndex(SESSIONS_INDEX, SESSIONS_INDEX_SETTINGS).catch(() => {});
await meili.ensureIndex(TURNS_INDEX, TURNS_INDEX_SETTINGS).catch(() => {});

// Follow CouchDB's change feed so docs written outside the ingest endpoints — the
// hook writes straight to CouchDB — reach the index without a manual reindex.
const follower = startSearchFollower(ctx);
console.log(
  follower
    ? "[search] following CouchDB changes for live indexing"
    : "[search] disabled — indexes will not update (features.meilisearch / MEILI_HOST)",
);

const app = buildServer(ctx);

console.log(`webapi listening on http://${config.webapi.host}:${config.webapi.port}`);

export default {
  port: config.webapi.port,
  hostname: config.webapi.host,
  fetch: app.fetch,
  // Bun closes a connection after 10s idle by default, which is shorter than some
  // legitimate admin requests: a full search rebuild grows with the corpus and
  // already exceeds it, so the client saw the socket drop while the server happily
  // finished the work. Raised to Bun's maximum — Tier 1 is a single user on
  // localhost, so holding connections open costs nothing.
  idleTimeout: 255,
};

/**
 * webapi entry point. Loads config, opens CouchDB + S3 handles, ensures the
 * schema, and serves the app. Bun serves the default export's `fetch`.
 */
import { buildAppModel } from "@claude-transcripts/shared";
import { indexName, loadAppConfigFile, loadConfig } from "./config";
import type { AppContext, BootStatus } from "./context";
import { buildServer } from "./server";
import { startChangesFollower } from "./storage/changes-follower";
import { makeCouch } from "./storage/couch";
import { ensureCouchDbs } from "./storage/ensure";
import {
  Meili,
  SESSIONS_INDEX_KEY,
  SESSIONS_INDEX_SETTINGS,
  TURNS_INDEX_KEY,
  TURNS_INDEX_SETTINGS,
} from "./storage/meili";
import { S3BlobStore } from "./storage/s3-blob-store";
import { createSessionIndex } from "./storage/session-index";

/** How often to rebuild the session index from scratch, as a staleness backstop. */
const SESSION_INDEX_RELOAD_MS = 15 * 60 * 1000;

const config = loadConfig();
const couch = makeCouch(config);
const blob = new S3BlobStore(config);
const meili = new Meili(config.meili);
// The app model (central state) — built once from the raw config + env, held
// in-memory, and served at `/`. Projections derive from it.
const model = buildAppModel(loadAppConfigFile(), process.env);
const boot = { startedAt: new Date().toISOString(), couchProvisioned: false } as BootStatus;
const sessionIndex = createSessionIndex(couch.db("sessions"));
const ctx: AppContext = { config, couch, blob, meili, model, boot, sessionIndex };

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
await meili
  .ensureIndex(indexName(config, SESSIONS_INDEX_KEY), SESSIONS_INDEX_SETTINGS)
  .catch(() => {});
await meili.ensureIndex(indexName(config, TURNS_INDEX_KEY), TURNS_INDEX_SETTINGS).catch(() => {});

// Warm the session index. Deliberately not awaited: the full grouped query is the
// slow thing this index exists to stop doing, and blocking startup on it would just
// move the wait. Until it lands, the list route queries CouchDB as it always did.
void sessionIndex.load().then(() => {
  const { sessions } = sessionIndex.status();
  console.log(`[session-index] warm — ${sessions} sessions`);
});
// A backstop, not the update path: the change feed keeps the index current, but a
// feed that dies would otherwise leave a stale list with no way back short of a
// restart. `unref` so this timer never holds the process open on its own.
setInterval(() => void sessionIndex.load(), SESSION_INDEX_RELOAD_MS).unref();

// Follow CouchDB's change feed so docs written outside the ingest endpoints — the
// hook writes straight to CouchDB — reach the index without a manual reindex.
startChangesFollower(ctx);
console.log(
  meili.enabled
    ? "[changes] following CouchDB changes — session index + search"
    : "[changes] following CouchDB changes — session index only (search disabled: features.meilisearch / MEILI_HOST)",
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

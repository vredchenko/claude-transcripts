import type { RouteDef } from "./types";

/**
 * The HTTP surface the gateway serves — a coarse map by **family**, not a second copy
 * of the endpoint list.
 *
 * The per-endpoint contract (methods, parameters, schemas) belongs to the OpenAPI spec
 * ([ADR 0019](../../../../docs/design/decisions/0019-openapi-source-of-truth-generated-clients.md)),
 * and duplicating it here would create a second source that drifts. What this is for is
 * the manifest at `/`: an agent arriving cold should be able to see what kinds of thing
 * live where, then follow `/api/openapi.json` for the details.
 *
 * Families, then — but *all* of them. This previously listed `/api/sessions` while
 * omitting search, ingest, migrate and turns entirely, so the map was missing rooms.
 */
export const ROUTES: RouteDef[] = [
  { path: "/", serves: "machine-readable app manifest (agent entrypoint)" },
  { path: "/health", serves: "liveness + store reachability" },
  { path: "/api", serves: "app JSON API (the gateway)" },
  { path: "/api/docs", serves: "Scalar API reference (renders the OpenAPI spec)" },
  { path: "/api/openapi.json", serves: "OpenAPI spec (contract source of truth)" },
  { path: "/api/couch/*", serves: "read-only CouchDB proxy" },
  { path: "/api/s3/*", serves: "read-only S3 proxy" },
  { path: "/api/sessions", serves: "session list / detail / transcript / turns" },
  { path: "/api/turns", serves: "turns across all sessions, time-ordered by speaker" },
  { path: "/api/search", serves: "full-text search over sessions + conversation content" },
  {
    path: "/api/ingest",
    serves: "curated write surface (summary/events/chunks/transcript, reset)",
  },
  { path: "/api/migrate", serves: "schema migration status / up / down" },
  { path: "/api/model", serves: "app model introspection (services/hooks/actions/env)" },
  { path: "/app", serves: "webui SPA" },
  { path: "/docs", serves: "rendered technical docs" },
  { path: "/cli/download", serves: "the bundled CLI binary" },
];

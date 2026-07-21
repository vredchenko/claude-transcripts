import type { RouteDef } from "./types";

/** The HTTP surface the gateway serves (drives the manifest + docs). */
export const ROUTES: RouteDef[] = [
  { path: "/", serves: "machine-readable app manifest (agent entrypoint)" },
  { path: "/api", serves: "app JSON API (the gateway)" },
  { path: "/api/docs", serves: "Scalar API reference (renders the OpenAPI spec)" },
  { path: "/api/openapi.json", serves: "OpenAPI spec (contract source of truth)" },
  { path: "/api/couch/*", serves: "read-only CouchDB proxy" },
  { path: "/api/s3/*", serves: "read-only S3 proxy" },
  { path: "/api/sessions", serves: "session list / detail / transcript" },
  { path: "/api/model", serves: "app model introspection (services/hooks/actions/env)" },
  { path: "/app", serves: "webui SPA" },
];

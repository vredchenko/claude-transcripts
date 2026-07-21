import type { EnvVarDef } from "./types";

/** The env schema (secrets/endpoints/ports/images). Grows as needed; .env.template mirrors it. */
export const ENV_VARS: EnvVarDef[] = [
  {
    name: "IMAGE_NS",
    scope: "image",
    description: "registry host/org for pulled images, e.g. ghcr.io/OWNER",
  },
  { name: "COUCHDB_TAG", scope: "image", default: "3", description: "CouchDB image tag" },
  { name: "GARAGE_TAG", scope: "image", default: "v2.3.0", description: "Garage image tag" },
  { name: "GARAGE_UI_TAG", scope: "image", default: "1.1.0", description: "Garage UI image tag" },
  { name: "MEILI_TAG", scope: "image", default: "v1.10", description: "Meilisearch image tag" },
  {
    name: "MEILI_UI_TAG",
    scope: "image",
    default: "latest",
    description: "Meilisearch UI image tag",
  },
  { name: "APP_TAG", scope: "image", default: "latest", description: "app image tag" },

  { name: "WEBAPI_PORT", scope: "port", default: "7650", description: "webapi host port" },
  { name: "WEBUI_PORT", scope: "port", default: "7651", description: "webui dev-server host port" },
  { name: "COUCHDB_PORT", scope: "port", default: "7652", description: "CouchDB host port" },
  {
    name: "GARAGE_S3_PORT",
    scope: "port",
    default: "7653",
    description: "Garage S3 API host port",
  },
  {
    name: "GARAGE_ADMIN_PORT",
    scope: "port",
    default: "7654",
    description: "Garage admin API host port",
  },
  {
    name: "GARAGE_WEBUI_PORT",
    scope: "port",
    default: "7655",
    description: "Garage web UI host port",
  },
  { name: "MEILI_PORT", scope: "port", default: "7656", description: "Meilisearch host port" },
  {
    name: "MEILI_UI_PORT",
    scope: "port",
    default: "7657",
    description: "Meilisearch UI host port",
  },

  { name: "WEBAPI_HOST", scope: "host", default: "127.0.0.1", description: "webapi bind host" },
  { name: "WEBUI_HOST", scope: "host", default: "127.0.0.1", description: "webui bind host" },
  { name: "CT_STATIC_DIR", scope: "host", description: "prebuilt SPA dir (prod image only)" },
  { name: "CT_VERSION", scope: "host", description: "baked release version" },

  { name: "COUCHDB_HOST", scope: "endpoint", default: "127.0.0.1", description: "CouchDB host" },
  { name: "COUCHDB_USER", scope: "secret", description: "CouchDB admin (blank in bundled dev)" },
  {
    name: "COUCHDB_PASSWORD",
    scope: "secret",
    description: "CouchDB password (blank in bundled dev)",
  },
  {
    name: "S3_ENDPOINT",
    scope: "endpoint",
    default: "http://127.0.0.1:7653",
    description: "S3 endpoint URL",
  },
  { name: "S3_REGION", scope: "endpoint", default: "garage", description: "S3 region" },
  { name: "S3_ACCESS_KEY", scope: "secret", description: "app-facing S3 access key" },
  { name: "S3_SECRET_KEY", scope: "secret", description: "app-facing S3 secret key" },
  { name: "GARAGE_RPC_SECRET", scope: "secret", description: "Garage internal RPC secret" },
  { name: "GARAGE_ADMIN_TOKEN", scope: "secret", description: "Garage admin token" },
  { name: "GARAGE_METRICS_TOKEN", scope: "secret", description: "Garage metrics token" },
  {
    name: "MEILI_HOST",
    scope: "endpoint",
    default: "http://127.0.0.1:7656",
    description: "Meilisearch endpoint URL",
  },
  {
    name: "MEILI_API_KEY",
    scope: "secret",
    description: "Meilisearch master key (blank in bundled dev)",
  },
];

import type { ServiceDef } from "./types";

/** Reserved local dev port range. */
export const DEV_PORT_RANGE = { start: 7650, end: 7661 } as const;

/**
 * The canonical service topology — the single place ports, images, mounts,
 * healthchecks, and the dev-vs-compose split are defined. Compose (generated),
 * the manifest, the stack runner, and the docs all project from here.
 */
export const SERVICES: ServiceDef[] = [
  {
    key: "webapi",
    name: "webapi",
    role: "gateway",
    ports: [{ internal: 7650, hostEnv: "WEBAPI_PORT", defaultHost: 7650 }],
    runsOnHostInDev: true,
    notes: "The I/O gateway + stability column. In deploy it runs as the `app` image.",
  },
  {
    key: "webui",
    name: "webui",
    role: "webui",
    ports: [{ internal: 7651, hostEnv: "WEBUI_PORT", defaultHost: 7651 }],
    runsOnHostInDev: true,
    notes: "Vite dev server in dev; built SPA served by the app at /app in prod.",
  },
  {
    key: "cli",
    name: "cli",
    role: "cli",
    runsOnHostInDev: true,
    notes: "User-facing CLI; no port.",
  },
  {
    key: "couchdb",
    name: "CouchDB",
    role: "backing",
    image: { name: "couchdb", tagEnv: "COUCHDB_TAG", defaultTag: "3", upstream: "couchdb" },
    ports: [
      { internal: 5984, hostEnv: "COUCHDB_PORT", defaultHost: 7652, label: "HTTP API + Fauxton" },
    ],
    adminUiServiceKey: "couchdbFauxton",
    volumes: [{ host: "./data/couchdb", container: "/opt/couchdb/data" }],
    healthcheck: { test: ["CMD", "curl", "-f", "http://localhost:5984/_up"] },
    notes: "Source of truth. Bundled dev = no auth (admin party). Fauxton at /_utils/.",
  },
  {
    key: "garage",
    name: "Garage (S3)",
    role: "backing",
    image: {
      name: "garage",
      tagEnv: "GARAGE_TAG",
      defaultTag: "v2.3.0",
      upstream: "dxflrs/garage",
    },
    ports: [
      { internal: 3900, hostEnv: "GARAGE_S3_PORT", defaultHost: 7653, label: "S3 API" },
      { internal: 3903, hostEnv: "GARAGE_ADMIN_PORT", defaultHost: 7654, label: "admin API" },
    ],
    volumes: [
      { host: "./data/garage/meta", container: "/var/lib/garage/meta" },
      { host: "./data/garage/data", container: "/var/lib/garage/data" },
      { host: "./garage.toml", container: "/etc/garage.toml", readonly: true },
    ],
    containerEnv: {
      GARAGE_RPC_SECRET: "${GARAGE_RPC_SECRET}",
      GARAGE_ADMIN_TOKEN: "${GARAGE_ADMIN_TOKEN}",
      GARAGE_METRICS_TOKEN: "${GARAGE_METRICS_TOKEN}",
    },
    healthcheck: { test: ["CMD", "/garage", "status"] },
    notes: "Distroless image — healthcheck uses the bundled CLI.",
  },
  {
    key: "garage-ui",
    name: "Garage Web UI",
    role: "admin-ui",
    image: {
      name: "garage-ui",
      tagEnv: "GARAGE_UI_TAG",
      defaultTag: "1.1.0",
      upstream: "khairul169/garage-webui",
    },
    ports: [{ internal: 3909, hostEnv: "GARAGE_WEBUI_PORT", defaultHost: 7655 }],
    adminUiServiceKey: "garageWebui",
    dependsOn: ["garage"],
    containerEnv: {
      API_BASE_URL: "http://garage:3903",
      API_ADMIN_KEY: "${GARAGE_ADMIN_TOKEN}",
      S3_ENDPOINT_URL: "http://garage:3900",
      S3_REGION: "garage",
    },
  },
  {
    key: "meilisearch",
    name: "Meilisearch",
    role: "backing",
    image: {
      name: "meilisearch",
      tagEnv: "MEILI_TAG",
      defaultTag: "v1.10",
      upstream: "getmeili/meilisearch",
    },
    ports: [{ internal: 7700, hostEnv: "MEILI_PORT", defaultHost: 7656 }],
    adminUiServiceKey: "meilisearch",
    volumes: [{ host: "./data/meilisearch", container: "/meili_data" }],
    containerEnv: { MEILI_ENV: "development" },
    notes: "Derived search index (optional/removable). Built-in UI on /.",
  },
  {
    key: "meilisearch-ui",
    name: "Meilisearch UI",
    role: "admin-ui",
    image: {
      name: "meilisearch-ui",
      tagEnv: "MEILI_UI_TAG",
      defaultTag: "latest",
      upstream: "riccoxie/meilisearch-ui",
    },
    ports: [{ internal: 24900, hostEnv: "MEILI_UI_PORT", defaultHost: 7657 }],
    dependsOn: ["meilisearch"],
  },
  {
    key: "app",
    name: "app (combined image)",
    role: "app",
    image: { name: "app", tagEnv: "APP_TAG", defaultTag: "latest" },
    ports: [{ internal: 7650, hostEnv: "WEBAPI_PORT", defaultHost: 7650 }],
    profiles: ["app"],
    dependsOn: ["couchdb", "garage", "meilisearch"],
    envFile: "../.env",
    containerEnv: {
      // Inside the compose network backends resolve to service names, not the
      // host's localhost ports. config/ + secrets stay shared; only endpoints differ.
      WEBAPI_HOST: "0.0.0.0",
      COUCHDB_HOST: "couchdb",
      COUCHDB_PORT: "5984",
      S3_ENDPOINT: "http://garage:3900",
      MEILI_HOST: "http://meilisearch:7700",
    },
    notes: "webapi + webui SPA + Scalar + bundled CLI; serves /app + /api.",
  },
];

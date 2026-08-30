import type { ServiceDef } from "./types";

/**
 * Where the project's own releases are published (ADR 0012): the app image and the
 * mirrored backing images (ADR 0024). Consumers that need a concrete, pullable image
 * ref with no `IMAGE_NS` to hand (the CLI's installer, the Kubernetes base) fall back
 * to this; a fork retargets it via `IMAGE_NS` / a kustomize `images:` override.
 */
export const RELEASE_IMAGE_NS = "ghcr.io/vredchenko";

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
    adminUiPath: "/_utils/",
    volumes: [{ host: "./data/couchdb", container: "/opt/couchdb/data" }],
    // CouchDB 3 REMOVED "admin party": without an admin the container refuses to
    // start and crash-loops. So the bundled stack ships a fixed default admin
    // (localhost-only) rather than no auth — the one exception to ADR 0020.
    containerEnv: {
      COUCHDB_USER: "${COUCHDB_USER:-admin}",
      COUCHDB_PASSWORD: "${COUCHDB_PASSWORD:-admin}",
    },
    healthcheck: { test: ["CMD", "curl", "-f", "http://localhost:5984/_up"] },
    notes: "Source of truth. Bundled dev = fixed default admin (CouchDB 3 requires one).",
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
      // Pinned like every other backing image: `latest` would make the mirrored
      // copy — and so the stack — irreproducible from one release to the next.
      defaultTag: "v0.14.1",
      upstream: "riccoxie/meilisearch-ui",
    },
    ports: [{ internal: 24900, hostEnv: "MEILI_UI_PORT", defaultHost: 7657 }],
    adminUiServiceKey: "meilisearchUi",
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
      // The port INSIDE the container is always 7650; `ports:` maps the host's
      // ${WEBAPI_PORT} onto it. Without pinning this, `env_file` hands the app the
      // HOST-side port and it binds there instead, so nothing answers on 7650 and the
      // published port leads nowhere. Invisible whenever the host port happens to be
      // 7650 — which is why it survived until an install shifted the block.
      WEBAPI_PORT: "7650",
      // COUCHDB_URL wins over HOST/PORT, so it must be pinned here too — otherwise
      // a `.env` set for an external CouchDB would leak into the bundled app.
      COUCHDB_URL: "http://couchdb:5984",
      // COUCHDB_HOST/COUCHDB_PORT are deliberately NOT pinned here. `COUCHDB_URL` wins
      // for every connection (resolveCouchUrl checks it first), so overriding them buys
      // nothing — and it actively breaks the services menu, which derives admin-UI links
      // from each service's host port. Pinned to the container-internal 5984, the menu
      // offered `127.0.0.1:5984` to a browser on the host, where nothing listens.
      // Leaving them alone lets env_file's host-side values through, which is what a
      // link meant for the host needs.
      S3_ENDPOINT: "http://garage:3900",
      MEILI_HOST: "http://meilisearch:7700",
    },
    // /health reports store reachability, not just liveness — so a pod goes Ready
    // only once CouchDB answers. Kubernetes-only (see the field's doc).
    httpHealth: { path: "/health", port: 7650 },
    notes: "webapi + webui SPA + Scalar + bundled CLI; serves /app + /api.",
  },
];

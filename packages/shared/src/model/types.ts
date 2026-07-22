/**
 * The app model — an abstract, isomorphic (pure-TS) data structure describing the
 * whole application: identity, services/ports, stores, hooks, actions, routes,
 * env schema, versions, and the api/cli specs. It aggregates config + metadata
 * about the current build source OR running deploy.
 *
 * It's built once from config + env (see build.ts) and then **projected** into
 * concrete artifacts (see project.ts): the `/` manifest, the docker-compose env,
 * the seed plan, etc. Both the Bun server and the React client import it — it's
 * just TypeScript. Facets marked "(grows)" are placeholders to fill in later.
 */

// ── Config file shape (config/config.json ↔ config.template.json) ──────────────

export interface AppConfigFile {
  app?: { name?: string };
  system: {
    logging: { chunk: { maxEntriesPerChunk: number; flushIntervalMs: number } };
    /**
     * Session-lifecycle tunables. `liveWindowMs` is how long after a session's last
     * activity a still-open (no SessionEnd) session is treated as `running`/live;
     * past it, it reads as `incomplete`/abandoned. `idleThresholdMs` is the gap
     * above which a session counts as idle when computing active (vs wall-clock)
     * duration. Both optional — the webapi defaults them.
     */
    sessions?: { liveWindowMs?: number; idleThresholdMs?: number };
  };
  /** logical key → CouchDB database name (multi-database by design) */
  couchdb: { databases: Record<string, string> };
  /** logical key → S3 bucket name (multi-bucket by design) */
  s3: { buckets: Record<string, string> };
  features: Record<string, boolean>;
  servicesMenu: Record<string, string>;
  userSettings?: Record<string, unknown>;
}

export type EnvLike = Record<string, string | undefined>;

// ── Facets ─────────────────────────────────────────────────────────────────────

export interface AppIdentity {
  codename: string; // "claude-transcripts"
  slug: string; // "claude-transcripts"
  title: string; // "Claude Transcripts"
  version: string; // lockstep semver (or "x.y.z+sha" for dispatch builds)
}

export type ServiceRole = "gateway" | "webui" | "cli" | "backing" | "admin-ui" | "app";

export interface ImageRef {
  /** suffix under the registry namespace, e.g. "couchdb" → <NS>/claude-transcripts-couchdb */
  name: string;
  /** env var that overrides the tag, e.g. "COUCHDB_TAG" */
  tagEnv: string;
  defaultTag: string;
  /**
   * The canonical UPSTREAM image (no tag), e.g. "dxflrs/garage". Set for images we
   * merely mirror to the GitHub Container Registry (GHCR); the upstream dev override
   * (toComposeOverrideObject) projects `${upstream}:${tag}` so a fresh clone can
   * `up` with no mirror. Our own images (the app) leave this unset.
   */
  upstream?: string;
}

export interface VolumeMount {
  /** host path relative to the compose dir, e.g. "./data/couchdb" */
  host: string;
  container: string;
  readonly?: boolean;
}

export interface PortMapping {
  internal: number;
  /** env var that sets the published host port */
  hostEnv: string;
  defaultHost: number;
  label?: string;
}

export interface ResolvedPort {
  internal: number;
  host: number;
  label?: string;
}

export interface HealthcheckDef {
  test: string[];
  interval?: string;
  timeout?: string;
  retries?: number;
}

export interface ServiceDef {
  key: string; // stable key, e.g. "couchdb"
  name: string; // display name
  role: ServiceRole;
  /** image (backing / admin-ui / app); host components (webapi/webui/cli) have none */
  image?: ImageRef;
  /** published ports (within the 7650–7661 dev range) */
  ports?: PortMapping[];
  /** ports resolved from env at build time (host falls back to defaultHost) */
  resolvedPorts?: ResolvedPort[];
  /** admin UI reachable via this servicesMenu key, if any */
  adminUiServiceKey?: string;
  /** runs on the host in dev (webapi/webui/cli) vs only in the compose stack */
  runsOnHostInDev?: boolean;
  dependsOn?: string[];
  volumes?: VolumeMount[];
  /** environment injected into the container (compose); endpoints differ from host */
  containerEnv?: Record<string, string>;
  /** env_file for the container (compose), e.g. "../.env" */
  envFile?: string;
  healthcheck?: HealthcheckDef;
  restart?: string;
  /** compose profiles, e.g. ["app"] */
  profiles?: string[];
  notes?: string;
}

export interface StoreModel {
  /** logical key → CouchDB database name */
  databases: Record<string, string>;
  /** logical key → S3 bucket name */
  buckets: Record<string, string>;
}

/**
 * Hook categories, in **lifecycle order** — a session opens at the top
 * (`session-start`) and closes at the bottom (`session-end`). The hooks doc
 * (gen-hook-events) groups + orders sections by this; HOOK_TYPES is kept in the
 * same order.
 */
export type HookCategory =
  | "session-start"
  | "turn-input"
  | "tool"
  | "subagent"
  | "display"
  | "environment"
  | "worktree"
  | "compaction"
  | "turn-end"
  | "session-end";

export interface HookTypeDef {
  event: string;
  category: HookCategory;
  canBlock: boolean;
  summary: string;
  /** is an action bound to it today */
  wired: boolean;
  /**
   * For intentionally-unwired events: a short reason we don't handle it (rendered
   * in the hook-events doc's "What we do" column). Omit for wired events.
   */
  ignoreReason?: string;
}

export interface ActionDef {
  key: string;
  summary: string;
  implemented: boolean;
}

export interface HookActionBinding {
  event: string;
  actions: string[]; // ActionDef keys
}

export interface RouteDef {
  path: string;
  serves: string;
}

export type EnvScope = "secret" | "endpoint" | "port" | "image" | "host" | "flag";

export interface EnvVarDef {
  name: string;
  scope: EnvScope;
  default?: string;
  description: string;
}

export interface CliArgDef {
  name: string;
  required?: boolean;
  description?: string;
}

export interface CliCommandDef {
  name: string;
  summary: string;
  args?: CliArgDef[];
}

export interface CliSpec {
  commands: CliCommandDef[];
}

export interface VersionChange {
  version: string;
  summary: string;
}

// ── The model ──────────────────────────────────────────────────────────────────

export interface AppModel {
  identity: AppIdentity;
  services: ServiceDef[];
  stores: StoreModel;
  hooks: HookTypeDef[];
  actions: ActionDef[];
  bindings: HookActionBinding[];
  routes: RouteDef[];
  env: EnvVarDef[];
  features: Record<string, boolean>;
  servicesMenu: Record<string, string>;
  system: AppConfigFile["system"];
  // (grows) — filled in as the project matures:
  apiSpec?: unknown; // the OpenAPI document (attached server-side)
  cliSpec?: CliSpec; // structured CLI params spec
  versionHistory?: VersionChange[];
}

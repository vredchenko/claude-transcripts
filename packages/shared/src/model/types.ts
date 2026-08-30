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

/** The `recall` section of the config file — same shape as the resolved policy. */
export interface RecallConfigFile {
  mode: "off" | "suggest" | "auto";
  scope: "project" | "host" | "all";
  maxResults: number;
  maxSnippetChars: number;
  triggers: { priorWorkQuestion: boolean; repeatedError: boolean; beforeRederiving: boolean };
  excludeCwdGlobs: string[];
  primer: { onSessionStart: boolean; maxTokens: number };
}

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
  /**
   * logical key → Meilisearch index name. Namespaced like the databases and buckets
   * above, so a deployment pointed at a shared Meilisearch can't collide with another
   * one — or have its indexes cleared by someone else's rebuild (ADR 0028).
   */
  meilisearch?: { indexes: Record<string, string> };
  features: Record<string, boolean>;
  servicesMenu: Record<string, string>;
  userSettings?: Record<string, unknown>;
  /** When a live session consults its own history (model/recall.ts). Optional; defaulted. */
  recall?: Partial<RecallConfigFile>;
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
  /** path under the service's host port for that admin UI (default "/") */
  adminUiPath?: string;
  /** runs on the host in dev (webapi/webui/cli) vs only in the compose stack */
  runsOnHostInDev?: boolean;
  dependsOn?: string[];
  volumes?: VolumeMount[];
  /** environment injected into the container (compose); endpoints differ from host */
  containerEnv?: Record<string, string>;
  /** env_file for the container (compose), e.g. "../.env" */
  envFile?: string;
  healthcheck?: HealthcheckDef;
  /**
   * HTTP readiness endpoint, for orchestrators that probe over HTTP (Kubernetes
   * `httpGet`). Separate from `healthcheck` because compose can only exec a command
   * inside the image, and the app image ships no curl to exec.
   */
  httpHealth?: { path: string; port: number };
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

/** How a CLI argument's value is read. Flags without `type`/`choices`/`default` are boolean. */
export type CliArgType = "string" | "number" | "boolean";

export interface CliArgDef {
  /** Positional (`action`) or flag (`--limit`). */
  name: string;
  required?: boolean;
  description?: string;
  /** Value type. Positionals default to `string`; flags default to `boolean`. */
  type?: CliArgType;
  /** Allowed values — feeds help, validation, and (later) completions. */
  choices?: readonly string[];
  /** Default shown in help; documentation only, the runner applies it. */
  default?: string | number | boolean;
}

/** Help groups, in display order (see CLI_SPEC.groups). */
export type CliGroup = "lifecycle" | "daily" | "portability" | "admin";

export interface CliCommandDef {
  name: string;
  summary: string;
  group: CliGroup;
  args?: CliArgDef[];
  /** Invocation examples, without the binary name — help prefixes it. */
  examples?: string[];
}

export interface CliSpec {
  /** Ordered groups; every command's `group` must be one of these. */
  groups: { key: CliGroup; title: string }[];
  /** Flags every command accepts (`--webapi`, `--help`, `--version`). */
  globalArgs: CliArgDef[];
  commands: CliCommandDef[];
}

export interface VersionChange {
  version: string;
  summary: string;
}

// ── Topology (the diagram scene) ───────────────────────────────────────────────
//
// `services.ts` is the *deployment* topology — what runs, on which port, from which
// image. This is the *communication* topology layered on top: who talks to whom, and
// how. It is a separate table because the picture's nodes are not the container set.
// It needs actors that aren't services (Claude Code, the hook, agents — nothing in
// SERVICES describes them) and must exclude a service that is (`app` is the combined
// image, the same box as `webapi`, not a second one). Labels and ports are read
// *through* `serviceKey` rather than copied, so a rename in services.ts moves the
// diagram too; `topology.test.ts` enforces that.

/**
 * Detail level. `compact` is the README/architecture view — who talks to whom and
 * what each thing is. `expanded` adds the interior detail (hook event categories,
 * CouchDB doc types + design views, route families, CLI commands, admin UIs).
 * Every renderer draws the SAME scene filtered by level, so growing the expanded
 * view can never make the compact one drift.
 */
export type DiagramLevel = "compact" | "expanded";

/** Where a node sits in the story — not where it sits on the page. */
export type TopologyNodeRole =
  | "producer" // Claude Code — emits the events
  | "writer" // the hook — the second writer (ADR 0016 amendment)
  | "client" // webui / cli / agents — HTTP consumers of the gateway
  | "gateway" // webapi — the stability column
  | "store" // CouchDB / Garage — durable
  | "index" // Meilisearch — derived, rebuildable
  | "admin-ui"; // Fauxton / garage-ui / meilisearch-ui (expanded only)

/** A vendored mark under `brand/icons/`, or `mark` for our own `brand/logo-mark.svg`. */
export type IconKey = "claude" | "mark" | "couchdb" | "garage" | "meilisearch";

/**
 * Which path through the system a node belongs to.
 *
 * A fact about the system, not about the picture: ADR 0016 is entirely the
 * distinction between the write path (Claude Code → hook → the stores, bypassing the
 * gateway) and the read path (webui/cli/agents → gateway → the stores). `store` is
 * the shared destination both converge on. A renderer keeps the two apart, which is
 * also what stops a read arrow from being drawn through the hook.
 */
export type TopologyLane = "write" | "read" | "store";

export interface TopologyNodeDef {
  key: string;
  /** The ServiceDef this node stands for, if any. Absent ⇒ an external actor. */
  serviceKey?: string;
  /** Overrides the service's `name` (e.g. "Garage (S3)" → "Garage"). Required if no serviceKey. */
  label?: string;
  /** Second line under the label, e.g. "source of truth". */
  caption?: string;
  role: TopologyNodeRole;
  icon?: IconKey;
  /** Logical column, 0 = leftmost. A meaning ("upstream of"), not a pixel. */
  rank: number;
  lane: TopologyLane;
  level: DiagramLevel;
  /** Feature flag that must be on for this node to exist (e.g. "s3Blobs"). */
  requiresFeature?: string;
  /** One line — used for the SVG `<desc>` and the expanded view's body text. */
  summary: string;
  /** Doc/ADR path justifying it, relative to `docs/`. */
  ref?: string;
}

export type TopologyEdgeKind =
  | "emits" // Claude Code → hook: one invocation per event
  | "direct-write" // the hook → CouchDB/S3, bypassing the gateway (ADR 0016 amendment)
  | "http-client" // webui/cli/agents → webapi
  | "curated-write" // webapi → store, through endpoints that own the doc/blob shape
  | "read-only-proxy" // webapi → store, /api/couch + /api/s3
  | "changes-follower" // webapi ← CouchDB _changes, the consequence of the bypass
  | "indexes" // webapi → Meilisearch
  | "serves-static" // webapi → the SPA and the docs
  | "admin-of"; // admin UI → its backing service

export interface TopologyEdgeDef {
  from: string; // TopologyNodeDef.key
  to: string;
  kind: TopologyEdgeKind;
  /** Short on-canvas label, e.g. "hook", "HTTP", "/api/couch (R/O)". */
  label?: string;
  /** Longer note — `<desc>` text and the expanded view; not drawn in compact. */
  note?: string;
  requiresFeature?: string;
  level: DiagramLevel;
  ref?: string;
}

/** A visual cluster, e.g. "clients", "stores". Members are node keys. */
export interface TopologyGroupDef {
  key: string;
  title: string;
  members: string[];
  level: DiagramLevel;
}

export interface TopologyModel {
  nodes: TopologyNodeDef[];
  edges: TopologyEdgeDef[];
  groups: TopologyGroupDef[];
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
  topology: TopologyModel;
  env: EnvVarDef[];
  features: Record<string, boolean>;
  servicesMenu: Record<string, string>;
  system: AppConfigFile["system"];
  /** The resolved recall policy — consumers read this, never the config section. */
  recall: RecallConfigFile;
  // (grows) — filled in as the project matures:
  apiSpec?: unknown; // the OpenAPI document (attached server-side)
  cliSpec?: CliSpec; // structured CLI params spec
  versionHistory?: VersionChange[];
}

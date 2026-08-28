import type {
  AppModel,
  DiagramLevel,
  HookCategory,
  IconKey,
  ServiceDef,
  TopologyEdgeKind,
  TopologyLane,
  TopologyNodeRole,
} from "./types";

/**
 * Projections — derive concrete artifacts from the model. Add new projectors here
 * (rather than re-deriving the same facts in each consumer): manifest, compose
 * env, compose file, seed plan, …
 */

/** The `/` manifest: what an agent/tool needs to bootstrap. Non-secret only. */
export function toManifest(model: AppModel) {
  return {
    app: model.identity.slug,
    codename: model.identity.codename,
    title: model.identity.title,
    version: model.identity.version,
    routes: Object.fromEntries(model.routes.map((r) => [r.path, r.serves])),
    services: model.services
      .filter((s) => s.role !== "cli")
      .map((s) => ({
        key: s.key,
        name: s.name,
        role: s.role,
        port: s.resolvedPorts?.[0]?.host,
      })),
    stores: {
      databases: Object.keys(model.stores.databases),
      buckets: Object.keys(model.stores.buckets),
    },
    features: model.features,
    servicesMenu: model.servicesMenu,
    recall: model.recall,
    hooks: {
      total: model.hooks.length,
      wired: model.hooks.filter((h) => h.wired).map((h) => h.event),
    },
    api: apiSummary(model),
  };
}

function apiSummary(model: AppModel): { spec: string; paths: number } | undefined {
  const spec = model.apiSpec as { paths?: Record<string, unknown> } | undefined;
  if (!spec) return undefined;
  return { spec: "/api/openapi.json", paths: Object.keys(spec.paths ?? {}).length };
}

/** The env vars (host ports + image tags) docker compose consumes. */
export function toComposeEnv(model: AppModel): Record<string, string> {
  const out: Record<string, string> = {};
  for (const s of model.services) {
    for (const p of s.ports ?? []) {
      const resolved = s.resolvedPorts?.find((r) => r.internal === p.internal);
      out[p.hostEnv] = String(resolved?.host ?? p.defaultHost);
    }
    if (s.image) out[s.image.tagEnv] = s.image.defaultTag;
  }
  return out;
}

/** What the seed step must ensure exists (create new, check existing). */
export function toSeedPlan(model: AppModel): { databases: string[]; buckets: string[] } {
  return {
    databases: Object.values(model.stores.databases),
    buckets: Object.values(model.stores.buckets),
  };
}

/**
 * Project the full docker-compose definition (as a plain object) from the
 * services topology. The gen-compose script serialises this to YAML — the compose
 * file is generated, not hand-maintained.
 */
export function toComposeObject(model: AppModel) {
  const services: Record<string, unknown> = {};
  for (const s of model.services) {
    if (s.role !== "backing" && s.role !== "admin-ui" && s.role !== "app") continue;
    services[s.key] = composeService(s);
  }
  return {
    name: "claude-transcripts",
    services,
    networks: { "claude-transcripts": { name: "claude-transcripts-network", driver: "bridge" } },
  };
}

/**
 * Project the **upstream-image dev override** (as a plain object). For every
 * service we merely mirror (has `image.upstream`), emit just an `image:` that
 * points at the canonical upstream image, so `docker compose -f base -f override`
 * runs with no registry mirror. Our own images (the app) have no upstream
 * and are left to the base file. The gen-compose-override script serialises this.
 */
export function toComposeOverrideObject(model: AppModel) {
  const services: Record<string, unknown> = {};
  for (const s of model.services) {
    if (!s.image?.upstream) continue;
    services[s.key] = {
      image: `${s.image.upstream}:\${${s.image.tagEnv}:-${s.image.defaultTag}}`,
    };
  }
  return { name: "claude-transcripts", services };
}

/**
 * Project the **image-mirror plan**: for every service we merely mirror (has
 * `image.upstream`), the pinned upstream reference and the `claude-transcripts-*`
 * name it is republished under (ADR 0024). The mirror script iterates this instead
 * of keeping its own copy of the image list — the model is the one place image
 * names and tags are declared, so the two can't drift.
 */
export function toMirrorPlan(model: AppModel): Array<{ upstream: string; dest: string }> {
  const plan: Array<{ upstream: string; dest: string }> = [];
  for (const s of model.services) {
    if (!s.image?.upstream) continue;
    plan.push({
      upstream: `${s.image.upstream}:${s.image.defaultTag}`,
      dest: `claude-transcripts-${s.image.name}:${s.image.defaultTag}`,
    });
  }
  return plan;
}

// ── Hook events doc projection ───────────────────────────────────────────────

/** Base URL of the official Claude Code hooks reference. */
export const HOOKS_DOC_URL = "https://code.claude.com/docs/en/hooks";

/** Deep link into the official hooks reference for one event. */
export function eventDocsUrl(event: string): string {
  return `${HOOKS_DOC_URL}#${event.toLowerCase()}`;
}

/** Kebab-case fixture-folder name for an event, e.g. PostToolUseFailure → post-tool-use-failure. */
export function eventFixtureDir(event: string): string {
  return event.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
}

export interface HookEventRow {
  event: string;
  category: HookCategory;
  /** one-line "fires when" (the model's hook summary, used verbatim) */
  firesWhen: string;
  wired: boolean;
  docsUrl: string;
  /** kebab fixture-folder name (under tests/mock/claude-code/hooks/) */
  fixtureDir: string;
  /** bound action keys — the "what we do", projected from BINDINGS */
  actions: string[];
  /** for unwired events: why we intentionally don't handle it */
  ignoreReason?: string;
}

/**
 * Project the hook-events table rows: every hook type, in model (lifecycle) order,
 * with its docs link, fixture folder, and the actions bound to it (the "what we
 * do" column — edit BINDINGS to change it). Rendered by gen-hook-events.
 */
export function toHookEventRows(model: AppModel): HookEventRow[] {
  return model.hooks.map((h) => ({
    event: h.event,
    category: h.category,
    firesWhen: h.summary,
    wired: h.wired,
    docsUrl: eventDocsUrl(h.event),
    fixtureDir: eventFixtureDir(h.event),
    actions: model.bindings.find((b) => b.event === h.event)?.actions ?? [],
    ignoreReason: h.ignoreReason,
  }));
}

function composeService(s: ServiceDef): Record<string, unknown> {
  const svc: Record<string, unknown> = {};
  if (s.profiles) svc.profiles = s.profiles;
  if (s.image) {
    svc.image = `\${IMAGE_NS}/claude-transcripts-${s.image.name}:\${${s.image.tagEnv}:-${s.image.defaultTag}}`;
  }
  svc.container_name = `claude-transcripts-${s.key}`;
  if (s.dependsOn?.length) svc.depends_on = s.dependsOn;
  if (s.envFile) svc.env_file = s.envFile;
  if (s.containerEnv) {
    svc.environment = Object.entries(s.containerEnv).map(([k, v]) => `${k}=${v}`);
  }
  if (s.ports?.length) {
    svc.ports = s.ports.map((p) => `127.0.0.1:\${${p.hostEnv}:-${p.defaultHost}}:${p.internal}`);
  }
  if (s.volumes?.length) {
    svc.volumes = s.volumes.map((v) => `${v.host}:${v.container}${v.readonly ? ":ro" : ""}`);
  }
  if (s.healthcheck) {
    svc.healthcheck = {
      test: s.healthcheck.test,
      interval: s.healthcheck.interval ?? "30s",
      timeout: s.healthcheck.timeout ?? "10s",
      retries: s.healthcheck.retries ?? 3,
    };
  }
  svc.restart = s.restart ?? "unless-stopped";
  svc.networks = ["claude-transcripts"];
  return svc;
}

// ── Architecture diagram projection ──────────────────────────────────────────
//
// The model owns the *scene* (which nodes and edges exist at this level, what they
// are called, what they mean); a renderer owns the *geometry* (pixels, colours,
// fonts). `rank` lives here because "the gateway is downstream of the clients" is a
// fact about the system; `x = 470` is a fact about a picture. That split is what
// lets the SVG generator, and any later renderer, consume one description.
//
// Isomorphic like the rest of the model — no fs, no measurement — so the webui can
// import this too.

export interface DiagramNode {
  key: string;
  /** Resolved: the node's own `label`, else the ServiceDef's `name`. */
  label: string;
  caption?: string;
  role: TopologyNodeRole;
  icon?: IconKey;
  rank: number;
  lane: TopologyLane;
  /** Resolved host port — only when the node is a service with one and `includePorts`. */
  port?: number;
  summary: string;
  ref?: string;
}

export interface DiagramEdge {
  from: string;
  to: string;
  kind: TopologyEdgeKind;
  label?: string;
  note?: string;
}

export interface DiagramGroup {
  key: string;
  title: string;
  members: string[];
}

export interface ArchitectureDiagram {
  level: DiagramLevel;
  title: string;
  subtitle: string;
  /** rank ascending, then declaration order — stable across runs. */
  nodes: DiagramNode[];
  edges: DiagramEdge[];
  groups: DiagramGroup[];
  /** Accessible prose assembled from the node/edge summaries. Becomes `<desc>`. */
  description: string;
}

export interface ArchitectureDiagramOptions {
  /** Default `"compact"`. */
  level?: DiagramLevel;
  /** Default `false` — ports are an expanded-view detail. */
  includePorts?: boolean;
}

/**
 * Project the topology into a layout-free scene at one detail level.
 *
 * A node whose `requiresFeature` is off is dropped, and so is every edge touching
 * it — without that orphan prune a disabled feature leaves arrows pointing into
 * nowhere, and the picture would claim a deployment shape the config denies.
 */
export function toArchitectureDiagram(
  model: AppModel,
  opts: ArchitectureDiagramOptions = {},
): ArchitectureDiagram {
  const level = opts.level ?? "compact";
  const wanted: DiagramLevel[] = level === "expanded" ? ["compact", "expanded"] : ["compact"];
  const on = (feature?: string) => feature === undefined || model.features[feature] === true;

  const byServiceKey = new Map(model.services.map((s) => [s.key, s]));

  const kept = model.topology.nodes.filter(
    (n) => wanted.includes(n.level) && on(n.requiresFeature),
  );
  const liveKeys = new Set(kept.map((n) => n.key));

  const nodes: DiagramNode[] = kept
    .map((n, i) => {
      const svc = n.serviceKey ? byServiceKey.get(n.serviceKey) : undefined;
      const node: DiagramNode = {
        key: n.key,
        label: n.label ?? svc?.name ?? n.key,
        role: n.role,
        rank: n.rank,
        lane: n.lane,
        summary: n.summary,
      };
      if (n.caption) node.caption = n.caption;
      if (n.icon) node.icon = n.icon;
      const port = opts.includePorts ? svc?.resolvedPorts?.[0]?.host : undefined;
      if (port !== undefined) node.port = port;
      if (n.ref) node.ref = n.ref;
      return { node, i };
    })
    .sort((a, b) => a.node.rank - b.node.rank || a.i - b.i)
    .map(({ node }) => node);

  const edges: DiagramEdge[] = model.topology.edges
    .filter(
      (e) =>
        wanted.includes(e.level) &&
        on(e.requiresFeature) &&
        liveKeys.has(e.from) &&
        liveKeys.has(e.to),
    )
    .map((e) => {
      const edge: DiagramEdge = { from: e.from, to: e.to, kind: e.kind };
      if (e.label) edge.label = e.label;
      if (e.note) edge.note = e.note;
      return edge;
    });

  const groups: DiagramGroup[] = model.topology.groups
    .filter((g) => wanted.includes(g.level))
    .map((g) => ({ key: g.key, title: g.title, members: g.members.filter((m) => liveKeys.has(m)) }))
    .filter((g) => g.members.length > 0);

  const label = (key: string) => nodes.find((n) => n.key === key)?.label ?? key;
  const description = [
    ...nodes.map((n) => `${n.label} — ${n.summary}`),
    ...edges.map((e) => `${label(e.from)} → ${label(e.to)}: ${e.note ?? e.label ?? e.kind}`),
  ].join(" ");

  return {
    level,
    title: model.identity.title,
    // Deliberately not the version: gen-diagram builds from the committed config
    // template with no env, so `identity.version` would be the "0.0.0-dev" fallback.
    subtitle: "self-hosted history for your Claude Code sessions",
    nodes,
    edges,
    groups,
    description,
  };
}

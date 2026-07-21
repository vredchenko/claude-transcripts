import type { AppModel, HookCategory, ServiceDef } from "./types";

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

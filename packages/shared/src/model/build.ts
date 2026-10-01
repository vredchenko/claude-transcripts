import { ACTIONS, BINDINGS } from "./actions";
import { CLI_SPEC } from "./cli";
import { ENV_VARS } from "./env";
import { HOOK_TYPES } from "./hooks";
import { resolveRecall } from "./recall";
import { ROUTES } from "./routes";
import { SERVICES } from "./services";
import { TOPOLOGY } from "./topology";
import type { AppConfigFile, AppModel, EnvLike, ServiceDef } from "./types";
import { resolveUserSettings } from "./user-settings";

/**
 * Assemble the app model from config + env. Pure + isomorphic — the Bun server
 * and the React client both call this. Static facets (services/hooks/actions/
 * routes/env) come from code; dynamic facets (names/ports/version/features) come
 * from config + env, so the model reflects the current build source or deploy.
 */
/**
 * Admin-UI links: config wins where it speaks, derivation fills the rest.
 *
 * A configured `servicesMenu` entry is the operator saying where a dashboard lives (an
 * external backend, a reverse proxy, another host), so it overrides the derived link —
 * the same config-first rule as `resolveUserSettings`. Keys the config leaves unset fall
 * back to `http://127.0.0.1:<resolved host port>`, right for the bundled stack on this
 * machine and following a per-instance port block. Config keys the model doesn't know
 * are carried through, so an operator can add links of their own.
 *
 * Templates before 0.3.3 shipped these links literally, so configs copied from them carry
 * the default ports. An entry equal to one of those is treated as unset, so a stale copy
 * can't override the derived link on an instance with its own port block.
 */
const STALE_TEMPLATE_LINKS: Record<string, string> = {
  couchdbFauxton: "http://127.0.0.1:7652/_utils/",
  garageWebui: "http://127.0.0.1:7655/",
  meilisearch: "http://127.0.0.1:7656/",
};

function buildServicesMenu(
  services: ServiceDef[],
  fromConfig: Record<string, string>,
): Record<string, string> {
  const derived: Record<string, string> = {};
  for (const s of services) {
    if (!s.adminUiServiceKey) continue;
    const port = s.resolvedPorts?.[0]?.host;
    if (!port) continue;
    const path = s.adminUiPath ?? "/";
    derived[s.adminUiServiceKey] = `http://127.0.0.1:${port}${path}`;
  }
  const configured = Object.entries(fromConfig).filter(([k, v]) => STALE_TEMPLATE_LINKS[k] !== v);
  return { ...derived, ...Object.fromEntries(configured) };
}

export function buildAppModel(config: AppConfigFile, env: EnvLike = {}): AppModel {
  const version = env.CT_VERSION ?? "0.0.0-dev";

  const services: ServiceDef[] = SERVICES.map((s) => ({
    ...s,
    resolvedPorts: (s.ports ?? []).map((p) => ({
      internal: p.internal,
      host: env[p.hostEnv] ? Number(env[p.hostEnv]) : p.defaultHost,
      label: p.label,
    })),
  }));

  return {
    identity: {
      codename: "claude-transcripts",
      slug: config.app?.name ?? "claude-transcripts",
      title: "Claude Transcripts",
      version,
    },
    services,
    stores: {
      databases: { ...config.couchdb.databases },
      buckets: { ...config.s3.buckets },
    },
    hooks: HOOK_TYPES,
    actions: ACTIONS,
    bindings: BINDINGS,
    routes: ROUTES,
    topology: TOPOLOGY,
    env: ENV_VARS,
    features: config.features,
    servicesMenu: buildServicesMenu(services, config.servicesMenu),
    system: config.system,
    recall: resolveRecall(config.recall, env),
    userSettings: resolveUserSettings(config.userSettings),
    cliSpec: CLI_SPEC,
  };
}

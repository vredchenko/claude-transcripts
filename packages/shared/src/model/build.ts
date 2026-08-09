import { ACTIONS, BINDINGS } from "./actions";
import { CLI_SPEC } from "./cli";
import { ENV_VARS } from "./env";
import { HOOK_TYPES } from "./hooks";
import { ROUTES } from "./routes";
import { SERVICES } from "./services";
import type { AppConfigFile, AppModel, EnvLike, ServiceDef } from "./types";

/**
 * Assemble the app model from config + env. Pure + isomorphic — the Bun server
 * and the React client both call this. Static facets (services/hooks/actions/
 * routes/env) come from code; dynamic facets (names/ports/version/features) come
 * from config + env, so the model reflects the current build source or deploy.
 */
/**
 * Admin-UI links, derived from the services' **resolved** ports.
 *
 * These used to be literal URLs in `config/`, carrying the template's default ports
 * (7652, 7655, …). `install` generates a per-instance port block, so on any instance
 * that didn't happen to get the defaults every link pointed at a closed port — and
 * since the values lived in the instance's own `app.json`, they looked authoritative
 * while being wrong.
 *
 * The model already knows each service's host port after env resolution, so it can say
 * where a dashboard actually is. Derived entries therefore WIN over the config file:
 * a stale default in an existing `app.json` must not override the truth. Config keys
 * the model doesn't know are still carried through, so an operator can add links of
 * their own.
 */
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
  // Config first so its extra keys survive; derived last so it wins on shared keys.
  return { ...fromConfig, ...derived };
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
    env: ENV_VARS,
    features: config.features,
    servicesMenu: buildServicesMenu(services, config.servicesMenu),
    system: config.system,
    cliSpec: CLI_SPEC,
  };
}

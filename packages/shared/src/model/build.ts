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
    servicesMenu: config.servicesMenu,
    system: config.system,
    cliSpec: CLI_SPEC,
  };
}

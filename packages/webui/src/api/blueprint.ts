import {
  type AppIdentity,
  DEFAULT_USER_SETTINGS,
  type RouteDef,
  resolveUserSettings,
  type ServiceDef,
  type StoreModel,
  type TopologyModel,
  type UserSettings,
} from "@claude-transcripts/shared";
import { type UseQueryResult, useQuery } from "@tanstack/react-query";

/**
 * A thin, hand-written client for `GET /api/blueprint` — the read-only blueprint
 * introspection endpoint (a plain Hono route, not part of the OpenAPI contract, so
 * it isn't in the generated client). Used for the header's title + build version, and
 * the header menus project from `services`, `topology`, `stores`, `routes` and
 * `servicesMenu` (see nav-menus.ts). Every facet is optional: an older webapi may not
 * serve one, and the UI degrades to leaving that part out.
 */
export interface AppBlueprintInfo {
  identity?: Partial<AppIdentity>;
  servicesMenu?: Record<string, string>;
  /** Configured store names — the real database / bucket / index behind each key. */
  stores?: Partial<StoreModel>;
  services?: ServiceDef[];
  topology?: Partial<TopologyModel>;
  routes?: RouteDef[];
  features?: Record<string, boolean>;
  /** Reader tunables — page sizes for the list and the transcript. */
  userSettings?: Partial<UserSettings>;
}

async function fetchAppBlueprint(): Promise<AppBlueprintInfo> {
  const res = await fetch("/api/blueprint");
  if (!res.ok) throw new Error(`GET /api/blueprint → ${res.status} ${res.statusText}`);
  return (await res.json()) as AppBlueprintInfo;
}

/**
 * An origin-relative URL into the read-only CouchDB proxy (ADR 0016). Unlike a Fauxton
 * link it needs no dashboard and no host port, so it works wherever the webui does.
 */
export function couchProxyUrl(db: string, path: string): string {
  return `/api/couch/${encodeURIComponent(db)}/${path}`;
}

/** Fauxton's hash route for a database path, tolerating a trailing slash on its URL. */
export function fauxtonUrlFor(fauxtonUrl: string, db: string, path: string): string {
  return `${fauxtonUrl.replace(/\/+$/, "")}/#/database/${encodeURIComponent(db)}/${path}`;
}

/** The blueprint rarely changes within a session, so cache it for the whole run. */
export function useAppBlueprint(): UseQueryResult<AppBlueprintInfo, Error> {
  return useQuery({
    queryKey: ["app-blueprint"],
    queryFn: fetchAppBlueprint,
    staleTime: Number.POSITIVE_INFINITY,
    retry: 1,
  });
}

/**
 * The resolved reader tunables — always a complete object.
 *
 * The views ask for a page size on their very first render, before `/api/blueprint` has
 * answered (and possibly after it has failed). Returning the defaults in that window,
 * rather than `undefined`, is what lets the list and the transcript start fetching
 * immediately instead of waiting on an introspection endpoint they don't otherwise
 * need. The gateway already resolves and clamps these; re-resolving here covers the
 * pre-answer window and an older webapi that doesn't serve the field yet.
 */
export function useUserSettings(): UserSettings {
  const { data } = useAppBlueprint();
  if (!data?.userSettings) return DEFAULT_USER_SETTINGS;
  return resolveUserSettings(data.userSettings);
}

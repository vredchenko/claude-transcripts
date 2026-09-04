import {
  DEFAULT_USER_SETTINGS,
  resolveUserSettings,
  type UserSettings,
} from "@claude-transcripts/shared";
import { type UseQueryResult, useQuery } from "@tanstack/react-query";

/**
 * A thin, hand-written client for `GET /api/model` — the read-only app-model
 * introspection endpoint (a plain Hono route, not part of the OpenAPI contract, so
 * it isn't in the generated client). Used for the header's title + build version;
 * `servicesMenu` is carried so the header links can become config-driven (#14).
 */
export interface AppModelInfo {
  identity?: { title?: string; version?: string; slug?: string; codename?: string };
  servicesMenu?: Record<string, string>;
  /** Reader tunables — page sizes for the list and the transcript. */
  userSettings?: Partial<UserSettings>;
}

async function fetchAppModel(): Promise<AppModelInfo> {
  const res = await fetch("/api/model");
  if (!res.ok) throw new Error(`GET /api/model → ${res.status} ${res.statusText}`);
  return (await res.json()) as AppModelInfo;
}

/** The app model rarely changes within a session, so cache it for the whole run. */
export function useAppModel(): UseQueryResult<AppModelInfo, Error> {
  return useQuery({
    queryKey: ["app-model"],
    queryFn: fetchAppModel,
    staleTime: Number.POSITIVE_INFINITY,
    retry: 1,
  });
}

/**
 * The resolved reader tunables — always a complete object.
 *
 * The views ask for a page size on their very first render, before `/api/model` has
 * answered (and possibly after it has failed). Returning the defaults in that window,
 * rather than `undefined`, is what lets the list and the transcript start fetching
 * immediately instead of waiting on an introspection endpoint they don't otherwise
 * need. The gateway already resolves and clamps these; re-resolving here covers the
 * pre-answer window and an older webapi that doesn't serve the field yet.
 */
export function useUserSettings(): UserSettings {
  const { data } = useAppModel();
  if (!data?.userSettings) return DEFAULT_USER_SETTINGS;
  return resolveUserSettings(data.userSettings);
}

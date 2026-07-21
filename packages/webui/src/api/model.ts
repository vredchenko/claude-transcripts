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

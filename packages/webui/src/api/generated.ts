/**
 * GENERATED API client — produced by `bun run gen:clients` (orval, from the webapi
 * OpenAPI spec; ADR 0019). Query hooks + fetchers are named after each route's
 * `operationId`.
 *
 * This file is the orval `target` (orval.config.ts → webui, `client: "react-query"`,
 * `baseUrl: "/api"`). The version committed here is a **snapshot**: it is overwritten
 * on regeneration — do not edit by hand. The webui is served same-origin under
 * `/app` with `/api` proxied to the webapi, so the transport is native `fetch` with
 * a `/api` base (no mutator, unlike the off-origin CLI client).
 */
import { type UseQueryOptions, type UseQueryResult, useQuery } from "@tanstack/react-query";

// ── Model types (inlined from the spec) ───────────────────────────────────────

export interface TokenUsage {
  input: number;
  output: number;
  cacheCreation: number;
  cacheRead: number;
  total: number;
  messages: number;
}

export type SessionStatus = "ended" | "running" | "incomplete";

export interface SessionSummary {
  sessionId: string;
  timestamp: string;
  startTimestamp?: string;
  durationMs?: number;
  activeMs?: number;
  model?: string;
  cwd: string;
  hostname: string;
  eventCount: number;
  promptCount: number;
  errorCount: number;
  toolCounts: Record<string, number>;
  endReason: string;
  hasTranscript: boolean;
  transcriptSize?: number;
  status: SessionStatus;
  lastActivity?: string;
  tokenUsage?: TokenUsage;
  source?: string;
}

export interface SessionsResponse {
  sessions: SessionSummary[];
  totalCount: number;
}

export interface TranscriptResponse {
  messages: Record<string, unknown>[];
  totalCount: number;
  hasMore: boolean;
}

export interface ListSessionsParams {
  limit?: number;
  skip?: number;
}

export interface GetSessionTranscriptParams {
  limit?: number;
  offset?: number;
}

// ── Transport ─────────────────────────────────────────────────────────────────

const BASE_URL = "/api";

function qs(params: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined) search.set(k, String(v));
  }
  const s = search.toString();
  return s ? `?${s}` : "";
}

async function request<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`);
  if (!res.ok) {
    let detail = "";
    try {
      const body = (await res.json()) as { error?: string };
      detail = body?.error ? `: ${body.error}` : "";
    } catch {
      // non-JSON error body — status line is enough
    }
    throw new Error(`GET ${path} → ${res.status} ${res.statusText}${detail}`);
  }
  return (await res.json()) as T;
}

// ── Fetchers (one per operationId) ────────────────────────────────────────────

/** GET /api/sessions */
export function listSessions(params: ListSessionsParams = {}): Promise<SessionsResponse> {
  return request<SessionsResponse>(`/sessions${qs({ limit: params.limit, skip: params.skip })}`);
}

/** GET /api/sessions/{id} */
export function getSession(id: string): Promise<SessionSummary> {
  return request<SessionSummary>(`/sessions/${encodeURIComponent(id)}`);
}

/** GET /api/sessions/{id}/transcript */
export function getSessionTranscript(
  id: string,
  params: GetSessionTranscriptParams = {},
): Promise<TranscriptResponse> {
  return request<TranscriptResponse>(
    `/sessions/${encodeURIComponent(id)}/transcript${qs({ limit: params.limit, offset: params.offset })}`,
  );
}

// ── Query keys ────────────────────────────────────────────────────────────────

export const queryKeys = {
  sessions: (params: ListSessionsParams = {}) => ["sessions", params] as const,
  session: (id: string) => ["session", id] as const,
  transcript: (id: string, params: GetSessionTranscriptParams = {}) =>
    ["session", id, "transcript", params] as const,
};

// ── React Query hooks ─────────────────────────────────────────────────────────

type QueryOpts<T> = Omit<UseQueryOptions<T, Error, T>, "queryKey" | "queryFn">;

export function useListSessions(
  params: ListSessionsParams = {},
  options?: QueryOpts<SessionsResponse>,
): UseQueryResult<SessionsResponse, Error> {
  return useQuery({
    queryKey: queryKeys.sessions(params),
    queryFn: () => listSessions(params),
    ...options,
  });
}

export function useGetSession(
  id: string,
  options?: QueryOpts<SessionSummary>,
): UseQueryResult<SessionSummary, Error> {
  return useQuery({
    queryKey: queryKeys.session(id),
    queryFn: () => getSession(id),
    enabled: Boolean(id),
    ...options,
  });
}

export function useGetSessionTranscript(
  id: string,
  params: GetSessionTranscriptParams = {},
  options?: QueryOpts<TranscriptResponse>,
): UseQueryResult<TranscriptResponse, Error> {
  return useQuery({
    queryKey: queryKeys.transcript(id, params),
    queryFn: () => getSessionTranscript(id, params),
    enabled: Boolean(id),
    ...options,
  });
}

/**
 * Hand-maintained API client (native `fetch` + react-query) for the webui. Hooks +
 * fetchers are named after each route's `operationId`.
 *
 * NOTE: despite ADR 0019, this file is currently **hand-written**, not orval output —
 * `orval.config.ts` (webui, `client: "react-query"`, no mutator) emits an **axios**
 * client that doesn't match this fetch shape (and axios isn't a webui dependency), so
 * `gen:clients` would overwrite this with something that won't compile. Reconciling
 * orval to be authoritative (webui `httpClient: "fetch"` + migrate consumers) is a
 * separate task; until then, extend this by hand in the existing style. The webui is
 * served under `/app` with `/api` proxied to the webapi, so transport is `fetch` on a
 * `/api` base.
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

export type SpeakerRole = "user" | "assistant" | "tool_result" | "system" | "other";

export interface SpeakerTurn {
  role: SpeakerRole;
  timestamp: string;
  text: string;
  toolUses?: { name: string; id?: string }[] | null;
  toolUseId?: string | null;
  isError?: boolean;
}

export interface SessionTurnsResponse {
  turns: SpeakerTurn[];
  totalCount: number;
  hasMore: boolean;
  role: SpeakerRole | null;
}

export interface CrossSessionTurn {
  sessionId: string;
  cwd: string;
  role: SpeakerRole;
  timestamp: string;
  text: string;
}

export interface CrossSessionTurnsResponse {
  turns: CrossSessionTurn[];
  hasMore: boolean;
  role: SpeakerRole | null;
}

export interface GetSessionTurnsParams {
  role?: SpeakerRole;
  limit?: number;
  offset?: number;
}

export interface GetTurnsParams {
  role?: SpeakerRole;
  from?: string;
  to?: string;
  limit?: number;
  skip?: number;
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

/** GET /api/sessions/{id}/turns — speaker-split turns for one session. */
export function getSessionTurns(
  id: string,
  params: GetSessionTurnsParams = {},
): Promise<SessionTurnsResponse> {
  return request<SessionTurnsResponse>(
    `/sessions/${encodeURIComponent(id)}/turns${qs({ role: params.role, limit: params.limit, offset: params.offset })}`,
  );
}

/** GET /api/turns — cross-session turns for one speaker, in time order. */
export function getTurns(params: GetTurnsParams = {}): Promise<CrossSessionTurnsResponse> {
  return request<CrossSessionTurnsResponse>(
    `/turns${qs({
      role: params.role,
      from: params.from,
      to: params.to,
      limit: params.limit,
      skip: params.skip,
    })}`,
  );
}

// ── Query keys ────────────────────────────────────────────────────────────────

export const queryKeys = {
  sessions: (params: ListSessionsParams = {}) => ["sessions", params] as const,
  session: (id: string) => ["session", id] as const,
  transcript: (id: string, params: GetSessionTranscriptParams = {}) =>
    ["session", id, "transcript", params] as const,
  turns: (id: string, params: GetSessionTurnsParams = {}) =>
    ["session", id, "turns", params] as const,
  crossTurns: (params: GetTurnsParams = {}) => ["turns", params] as const,
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

export function useGetSessionTurns(
  id: string,
  params: GetSessionTurnsParams = {},
  options?: QueryOpts<SessionTurnsResponse>,
): UseQueryResult<SessionTurnsResponse, Error> {
  return useQuery({
    queryKey: queryKeys.turns(id, params),
    queryFn: () => getSessionTurns(id, params),
    enabled: Boolean(id),
    ...options,
  });
}

export function useGetTurns(
  params: GetTurnsParams = {},
  options?: QueryOpts<CrossSessionTurnsResponse>,
): UseQueryResult<CrossSessionTurnsResponse, Error> {
  return useQuery({
    queryKey: queryKeys.crossTurns(params),
    queryFn: () => getTurns(params),
    ...options,
  });
}

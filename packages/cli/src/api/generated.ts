/**
 * GENERATED API client — produced by `bun run gen:clients` (orval, from the webapi
 * OpenAPI spec; ADR 0019). Functions are named after each route's `operationId`.
 *
 * This file is the orval `target` (orval.config.ts → cli). The version committed
 * here is a **snapshot**: it is overwritten on regeneration — do not edit by hand.
 * Transport is the `customFetch` mutator in ./http. (Regeneration also inlines the
 * model types from the spec; until then they're reused from ../lib/session-docs.)
 */
import type {
  MigrationRunResult,
  MigrationStatus,
  SessionSummary,
  SessionsResponse,
  TranscriptResponse,
} from "@claude-transcripts/shared";
import type { ChunkDoc, EventDoc, SummaryDoc } from "../lib/session-docs";
import { customFetch } from "./http";

function query(params: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined) search.set(k, String(v));
  }
  const s = search.toString();
  return s ? `?${s}` : "";
}

export interface IngestSummaryResult {
  ok: boolean;
  id: string;
  updated: boolean;
}
export interface IngestEventsResult {
  ok: boolean;
  inserted: number;
}

/** A migrate up/down response — the run result plus the engine's progress log. */
export type MigrationRunResponse = MigrationRunResult & { log: string[] };

/** GET /api/sessions */
export function listSessions(
  params: { limit?: number; skip?: number } = {},
): Promise<SessionsResponse> {
  return customFetch<SessionsResponse>(`/api/sessions${query(params)}`, { method: "GET" });
}

/** GET /api/sessions/{id} */
export function getSession(id: string): Promise<SessionSummary> {
  return customFetch<SessionSummary>(`/api/sessions/${encodeURIComponent(id)}`, { method: "GET" });
}

/** GET /api/sessions/{id}/transcript */
export function getSessionTranscript(
  id: string,
  params: { limit?: number; offset?: number } = {},
): Promise<TranscriptResponse> {
  return customFetch<TranscriptResponse>(
    `/api/sessions/${encodeURIComponent(id)}/transcript${query(params)}`,
    { method: "GET" },
  );
}

/** POST /api/ingest/summary */
export function ingestSummary(summaryDoc: SummaryDoc): Promise<IngestSummaryResult> {
  return customFetch<IngestSummaryResult>("/api/ingest/summary", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(summaryDoc),
  });
}

/** POST /api/ingest/events */
export function ingestEvents(body: { docs: EventDoc[] }): Promise<IngestEventsResult> {
  return customFetch<IngestEventsResult>("/api/ingest/events", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** POST /api/ingest/chunks */
export function ingestChunks(body: { docs: ChunkDoc[] }): Promise<IngestEventsResult> {
  return customFetch<IngestEventsResult>("/api/ingest/chunks", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** GET /api/migrate/status */
export function migrateStatus(): Promise<MigrationStatus> {
  return customFetch<MigrationStatus>("/api/migrate/status", { method: "GET" });
}

/** POST /api/migrate/up */
export function migrateUp(
  body: { to?: number; dryRun?: boolean } = {},
): Promise<MigrationRunResponse> {
  return customFetch<MigrationRunResponse>("/api/migrate/up", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** POST /api/migrate/down */
export function migrateDown(
  body: { steps?: number; dryRun?: boolean } = {},
): Promise<MigrationRunResponse> {
  return customFetch<MigrationRunResponse>("/api/migrate/down", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

import { hostname } from "node:os";
import { type BlobClient, makeBlob } from "./blob";
import { type HookConfig, loadConfig } from "./config";
import { type CouchClient, makeCouch } from "./couch";
import { type CountsStore, makeCounts } from "./counts";

export interface HookContext {
  event: string;
  sessionId: string;
  cwd: string;
  hostname: string;
  timestamp: string;
  transcriptPath?: string;
  payload: any;
  config: HookConfig;
  couch: CouchClient;
  blob: BlobClient;
  counts: CountsStore;
  /** resolved store names (from the keyed config) */
  sessionsDb: string;
  sessionsBucket?: string;
}

/** Build the per-invocation context, or null to silently skip (no config / payload). */
export function buildContext(payload: any): HookContext | null {
  const config = loadConfig();
  if (!config) return null;

  const event: string | undefined = payload?.hook_event_name;
  const sessionId: string | undefined = payload?.session_id;
  if (!event || !sessionId) return null;

  return {
    event,
    sessionId,
    cwd: payload?.cwd ?? "",
    hostname: hostname(),
    timestamp: new Date().toISOString(),
    transcriptPath: payload?.transcript_path,
    payload,
    config,
    couch: makeCouch(config),
    blob: makeBlob(config),
    counts: makeCounts(sessionId),
    sessionsDb: config.couch.databases.sessions,
    sessionsBucket: config.blob?.buckets.sessions,
  };
}

/** The fields stamped on every session doc (event/summary/chunk). */
export function commonFields(ctx: HookContext) {
  return {
    event: ctx.event,
    session_id: ctx.sessionId,
    timestamp: ctx.timestamp,
    hostname: ctx.hostname,
    cwd: ctx.cwd,
  };
}

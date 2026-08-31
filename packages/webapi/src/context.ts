import type { AppModel } from "@claude-transcripts/shared";
import type { Config } from "./config";
import type { BlobStore } from "./storage/blob-store";
import type { CouchHandles } from "./storage/couch";
import type { Meili } from "./storage/meili";
import type { SessionIndex } from "./storage/session-index";

/**
 * Outcome of boot-time provisioning. Startup deliberately never blocks on the
 * stores (the app must come up so you can see *why* it is unhappy), so this
 * records what happened for `/health` to report — otherwise a webapi with no
 * databases looks identical to a healthy one until the first write fails.
 */
export interface BootStatus {
  /** ISO timestamp of process start. */
  startedAt: string;
  /** Did `ensureCouchDbs` (databases + migrations) complete? */
  couchProvisioned: boolean;
  /** Why it didn't, when it didn't. */
  error?: string;
}

/** Everything the route handlers need. Built once at boot in index.ts. */
export interface AppContext {
  config: Config;
  couch: CouchHandles;
  blob: BlobStore;
  /** full-text search (optional; best-effort — no-ops when disabled/unreachable) */
  meili: Meili;
  /** the isomorphic app model (central state) — served at `/`, used by routes */
  model: AppModel;
  /**
   * Per-session aggregates held in memory and patched from the change feed, so the
   * session list doesn't re-reduce the whole corpus on every request (#107). A cache:
   * callers check `ready` and fall back to querying CouchDB when it is false.
   */
  sessionIndex: SessionIndex;
  /** what boot-time store provisioning did — reported by `/health` */
  boot: BootStatus;
}

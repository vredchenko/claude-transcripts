import type { AppModel } from "@claude-transcripts/shared";
import type { Config } from "./config";
import type { BlobStore } from "./storage/blob-store";
import type { CouchHandles } from "./storage/couch";
import type { Meili } from "./storage/meili";

/** Everything the route handlers need. Built once at boot in index.ts. */
export interface AppContext {
  config: Config;
  couch: CouchHandles;
  blob: BlobStore;
  /** full-text search (optional; best-effort — no-ops when disabled/unreachable) */
  meili: Meili;
  /** the isomorphic app model (central state) — served at `/`, used by routes */
  model: AppModel;
}

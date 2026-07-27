import { withCouchAuth } from "@claude-transcripts/shared";
import nano, { type DocumentScope, type ServerScope } from "nano";
import { type Config, dbName } from "../config";

export interface CouchHandles {
  server: ServerScope;
  /** Open a database scope by its logical key (e.g. "sessions", "appLogs"). */
  db: (key: string) => DocumentScope<unknown>;
  /** Base server URL (with auth if configured) — used by the read-only proxy. */
  url: string;
}

/**
 * Build the CouchDB handles from the resolved base URL + credentials.
 *
 * Caveat for a base URL carrying a **path prefix** (`https://host/couchdb`):
 * whether it survives depends on how nano joins the database name onto the base.
 * Our own callers (the proxy, `ensure`) concatenate and are fine; the nano path
 * is untested — verify before relying on a prefixed deployment.
 */
export function makeCouch(config: Config): CouchHandles {
  const { url: base, user, password } = config.couchdb;
  const url = withCouchAuth(base, user, password);
  const server = nano(url);
  return {
    server,
    db: (key) => server.db.use(dbName(config, key)),
    url,
  };
}

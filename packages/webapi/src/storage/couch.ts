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

/**
 * `fetch` against CouchDB, with credentials sent as a header.
 *
 * `CouchHandles.url` carries credentials as URL userinfo because that's what nano
 * reads — but **`fetch` does not send userinfo**. Passing that URL straight to `fetch`
 * produces an anonymous request, and an authenticated CouchDB answers 401. That has
 * already bitten twice (`/health` reporting every deployment as degraded, and the
 * read-only `/api/couch` proxy rejecting every request), so the conversion lives here
 * once instead of at each call site.
 */
export async function couchFetch(
  couchUrl: string,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const url = new URL(`${couchUrl}${path}`);
  const { username, password } = url;
  url.username = "";
  url.password = "";
  // `Headers` normalises every HeadersInit shape the caller might pass.
  const headers = new Headers(init.headers);
  if (username) {
    const creds = `${decodeURIComponent(username)}:${decodeURIComponent(password)}`;
    headers.set("authorization", `Basic ${btoa(creds)}`);
  }
  return fetch(url, { ...init, headers });
}

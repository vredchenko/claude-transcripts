/**
 * CouchDB endpoint resolution — one place every consumer (webapi, cli, seed
 * script) turns env into a base URL, so a full `COUCHDB_URL` works everywhere.
 *
 * `COUCHDB_URL` is the endpoint; it wins over `COUCHDB_HOST` + `COUCHDB_PORT`,
 * which stay as the bundled-stack convenience default (`http://127.0.0.1:7652`).
 * Because it is a URL, external CouchDB over **HTTPS** and behind a **path
 * prefix** (`https://couch.example.com/couchdb`) both work — see
 * docs/configuration.md.
 *
 * Credentials are kept OUT of the resolved URL: `resolveCouchUrl` returns a
 * clean, loggable endpoint, and `withCouchAuth` injects `COUCHDB_USER` /
 * `COUCHDB_PASSWORD` only where a client actually needs them (nano takes auth
 * in the URL). Mirrors the CLI's `CT_WEBAPI_URL` override.
 */

export const DEFAULT_COUCHDB_HOST = "127.0.0.1";
export const DEFAULT_COUCHDB_PORT = "7652";

/** The env vars this module reads (a subset of `process.env`). */
export interface CouchEnv {
  COUCHDB_URL?: string;
  COUCHDB_HOST?: string;
  COUCHDB_PORT?: string;
  COUCHDB_USER?: string;
  COUCHDB_PASSWORD?: string;
}

/** Drop trailing slashes so callers can always append `/<db>`. */
function trimTrailingSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

/**
 * The CouchDB base URL, without credentials and without a trailing slash.
 *
 * A `COUCHDB_URL` with no scheme is read as `http://` (the local-first default);
 * write `https://` explicitly for TLS.
 */
export function resolveCouchUrl(env: CouchEnv = {}): string {
  const explicit = env.COUCHDB_URL?.trim();
  if (explicit) {
    const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(explicit) ? explicit : `http://${explicit}`;
    return trimTrailingSlash(withScheme);
  }
  const host = env.COUCHDB_HOST || DEFAULT_COUCHDB_HOST;
  const port = env.COUCHDB_PORT || DEFAULT_COUCHDB_PORT;
  return `http://${host}:${port}`;
}

/**
 * Return `url` with `user`/`password` embedded in the authority (the form nano
 * and plain `fetch` accept). No user ⇒ returned unchanged; credentials already
 * present in `url` are left alone.
 */
export function withCouchAuth(url: string, user?: string, password?: string): string {
  if (!user) return url;
  const parsed = new URL(url);
  if (parsed.username) return url;
  // encodeURIComponent first: the URL setters escape `@`/`:` but not `%`, so
  // pre-encoding is what makes a credential containing either round-trip.
  parsed.username = encodeURIComponent(user);
  parsed.password = encodeURIComponent(password ?? "");
  return trimTrailingSlash(parsed.toString());
}

/** Convenience: the resolved URL with any configured credentials applied. */
export function resolveCouchUrlWithAuth(env: CouchEnv = {}): string {
  return withCouchAuth(resolveCouchUrl(env), env.COUCHDB_USER, env.COUCHDB_PASSWORD);
}

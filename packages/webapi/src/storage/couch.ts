import nano, { type DocumentScope, type ServerScope } from "nano";
import { type Config, dbName } from "../config";

export interface CouchHandles {
  server: ServerScope;
  /** Open a database scope by its logical key (e.g. "sessions", "appLogs"). */
  db: (key: string) => DocumentScope<unknown>;
  /** Base server URL (with auth if configured) — used by the read-only proxy. */
  url: string;
}

export function makeCouch(config: Config): CouchHandles {
  const { host, port, user, password } = config.couchdb;
  const auth = user ? `${encodeURIComponent(user)}:${encodeURIComponent(password ?? "")}@` : "";
  const url = `http://${auth}${host}:${port}`;
  const server = nano(url);
  return {
    server,
    db: (key) => server.db.use(dbName(config, key)),
    url,
  };
}

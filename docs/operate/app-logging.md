# Application logging

**Not built.** Components log to stderr (the webui to the browser console). The
webapi creates the app-logs database (`couchdb.databases.appLogs`,
`claude-transcripts-app-logs` by default) on boot, but nothing writes to it: the
`app-log` action is unbound and there is no log endpoint.

The plan ([ADR 0018](../design/decisions/0018-app-logging-into-couchdb.md)): the
webapi, webui, CLI and hook send their errors and diagnostics through the webapi (a
future `POST /api/logs`) into that separate database, so operational noise stays out
of the session views and has its own retention and compaction. It stays optional: if
the database is unreachable, components fall back to stderr. A proposed record:

```jsonc
{
  "type": "log",
  "timestamp": "…",
  "level": "error",          // debug | info | warn | error
  "component": "webapi",     // webapi | webui | cli | hook
  "session_id": "…",         // optional
  "message": "…",
  "context": {}
}
```

Open: retention, views, sampling of debug logs, and applying the same secrets masking
as session data.

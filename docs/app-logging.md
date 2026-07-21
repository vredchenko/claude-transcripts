# Application & operational logging

> **Status: specified, not yet built** (placeholder schema). Decision recorded in
> [ADR 0018](decisions/0018-app-logging-into-couchdb.md).

The system's **own** logs — failures, errors, diagnostics from the **webapi,
webui, CLI, and hook** — are aggregated into **CouchDB, in a database separate
from the session data** (e.g. `app-logs` alongside `claude-sessions`). This is
distinct from the *session* corpus the product captures; keeping it in its own DB
keeps operational noise out of the session views.

## Why CouchDB again

- No new infrastructure — we already run a document store with an HTTP API, the
  same vendor-neutral story, the same query tooling.
- A separate database (not just a separate `type`) isolates retention, views, and
  compaction from the session corpus.

## How it flows

- Components emit log records **through the webapi**
  ([ADR 0016](decisions/0016-webapi-is-the-io-gateway.md)) — e.g. an
  `POST /api/logs` endpoint — rather than writing to CouchDB directly. The webui
  ships client errors the same way.
- The app-log DB is **optional** (Tier 1/2): if it's unreachable, components fall
  back to stderr / local logs and lose only centralised aggregation — never core
  function. The hook's never-block discipline applies here too.

## Record shape (placeholder)

To be finalised. Anticipated fields:

```jsonc
{
  "type": "log",
  "ts": "…",                 // explicit timestamp (CouchDB doesn't stamp wall-clock)
  "level": "error",          // debug | info | warn | error
  "component": "webapi",     // webapi | webui | cli | hook
  "session_id": "…",         // optional correlation to a session
  "message": "…",
  "context": { /* arbitrary */ }
}
```

## Open questions (placeholder)

- Retention / rotation policy (bounded DB; periodic purge or `_purge`/compaction).
- Design views (by component, by level, by day) — TBD.
- Whether to sample/aggregate high-volume debug logs.
- Privacy: app logs must respect the same secrets-masking rules as session data
  (ties to issue
  #11).

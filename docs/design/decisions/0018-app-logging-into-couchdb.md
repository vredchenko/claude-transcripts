# 18. Application/operational logs go to CouchDB (separate database)

Date: 2026-06-18

## Status

Accepted, not yet implemented. Amended 2026-09-30 — see
[Amendment](#amendment-nothing-writes-the-app-logs-database-yet).

## Context

The system itself — webapi, webui, CLI, hook — produces operational logs
(failures, errors, diagnostics). These are distinct from the *session* data the
product is about. We need somewhere to aggregate them, and we'd rather not add a
new piece of infrastructure when we already run a document store with an HTTP API.

## Decision

Aggregate the **application's own logs into CouchDB, in a separate database** from
the session data (`claude-transcripts-app-logs` alongside
`claude-transcripts-sessions`; both names were shorter when this was written and
are per-instance configurable). All components —
webapi, webui (client errors shipped via the webapi), CLI, hook — write their
operational log/error records there, through the webapi (per
[ADR 0016](0016-webapi-is-the-io-gateway.md)).

- Separate DB keeps operational noise out of the session corpus and out of its
  design views.
- Same backend means no new dependency, the same HTTP/query tooling, and the same
  vendor-neutral story.
- The app-log DB is **optional** (Tier 1/2): if absent, components fall back to
  stderr/local logs and lose only centralised aggregation — never core function.

## Consequences

- One place to inspect cross-component failures (useful as the surface area grows).
- Needs a light, bounded schema + retention/rotation policy (placeholder for now —
  see [app-logging.md](../../operate/app-logging.md)).
- Components must degrade gracefully when the app-log DB is unreachable, exactly as
  the hook already does for session writes.
- If a separate store ever suits operational logs better, the abstraction lives
  behind the webapi and can be swapped without touching emitters.

## Amendment: nothing writes the app-logs database yet

*2026-09-30.*

Not built yet. The webapi creates the app-logs DB at boot (as it does every
`couchdb.databases` entry), but nothing writes to it: the `app-log` action is
`implemented: false` and there is no ingest route. Components log to stderr (the webui
to the console). Schema: [app-logging.md](../../operate/app-logging.md).

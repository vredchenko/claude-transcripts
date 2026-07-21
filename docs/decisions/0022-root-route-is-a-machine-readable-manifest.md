# 22. `/` serves a machine-readable app manifest (agent entrypoint)

Date: 2026-06-18

## Status

Accepted

## Context

The webui lives at `/app` and the human/OpenAPI surface at `/api/docs`. That
leaves `/` free, and we deliberately **do not** want it to be a human landing
page. A primary consumer of this system is **other AI agents** (#15),
which need a single, discoverable entrypoint that describes the live app without
scraping HTML or guessing routes.

## Decision

`/` serves a **machine-readable definition of the live app** — JSON (with optional
MDX for prose parts) — acting as the **entrypoint for agents and tooling**. It
carries:

- the **available routes/endpoints** and how to reach them (a compact pointer to
  the full OpenAPI at `/api/docs`, plus the `/api/couch` and `/api/s3` proxies);
- **non-secret config** the app is running with (a config-serving route);
- **dynamic links** the webui can consume (e.g. the Services-menu URLs, so they're
  not hard-coded in the SPA — relates to #14);
- **version & build** info;
- whatever else an agent needs to bootstrap use of the system.

It is the agent/automation front door; `/api/docs` remains the human + OpenAPI
surface, `/app` the human UI.

## Consequences

- Agents hit `/` once to discover everything — routes, config, version, links —
  instead of hard-coding paths.
- The webui can pull its dynamic links/config from `/` rather than baking them in
  (config-driven Services menu).
- `/` is served by the webapi (the gateway) and must stay non-secret and stable —
  it's part of the public contract surface.
- Exact schema of the manifest is TBD; see [routes.md](../routes.md).

# 2. Single combined container serves the API and the SPA

Date: 2026-06-06

## Status

Accepted

## Context

A predecessor ran the webapi and webui as two separate services/images. The
monorepo template — used here as the structural reference — instead ships one
image where a single Bun process serves both `/api/*` and the prebuilt static
SPA. We had to pick one shape for the standalone project.

For this project the webui is a thin read-only viewer over the webapi; there is
no independent scaling story for the two, and a primary goal is being trivial to
self-host anywhere (a single `docker run` / one compose service).

## Decision

Ship a **single combined image**. The Bun webapi (`packages/webapi`) serves the
JSON API and, when `CT_STATIC_DIR` is set, also serves the built webui SPA with
an index.html fallback. In development the two run separately (Vite dev server
proxies `/api` to the webapi); in production they are one process on one port.

## Consequences

- One image to build, scan, publish, and deploy; one origin for the browser, so
  no CORS configuration.
- The webui has no runtime config of its own — it always calls same-origin
  `/api/...`.
- If the UI ever needs independent scaling or a CDN, this would be revisited
  (a new ADR), but that is explicitly out of scope for Phase 1.

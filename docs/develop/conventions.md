# Conventions

## Naming

- **Codename:** `claude-transcripts`
- **Slug** (repo / package / container / image): `claude-transcripts`
- **Verbose title:** Claude Transcripts

Use these consistently across code, config, and docs. Workspace packages are
scoped `@claude-transcripts/*`; app-specific env vars use the `CT_` prefix
(`CT_STATIC_DIR`, `CT_VERSION`).

## Components

- `packages/@claude-transcripts/{shared, webapi, webui, cli}` — the custom components
  (`cli` is the user-facing tool).
- `hooks/` — the Claude Code plugin (writer).
- `scripts/` — **dev-only** automation; **`cli/`** — user-useful operations.
  (Rule: dev-only → `scripts/`; user-useful → `cli/`. There is no `tools/` dir.)
- `deploy/` — Docker Compose (backing services + admin UIs).

## Ports (dev range `7650–7661`)

| Port | Service |
|------|---------|
| 7650 | webapi |
| 7651 | webui (Vite) |
| 7652 | CouchDB (+ Fauxton `/_utils/`) |
| 7653 | Garage S3 API |
| 7654 | Garage admin API |
| 7655 | Garage web UI |
| 7656 | Meilisearch (+ built-in UI) |
| 7657–7661 | reserved |

## Stack

Bun + TypeScript (ESM, strict). webapi: Hono + zod-openapi + Scalar. webui:
React 19 + Vite + MUI + TanStack Router/Query. cli: Ink. Storage: CouchDB +
S3 (Garage) + Meilisearch. Biome + lefthook. API clients **generated** from the
OpenAPI spec (orval).

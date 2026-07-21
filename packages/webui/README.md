# @claude-transcripts/webui

The viewer — a React SPA over the webapi. **Optional** interface (everything is
reachable via the CLI/API). Served at `/app` by the combined image in prod; in dev
Vite serves it on `7651` and proxies `/api` → webapi on `7650`.

- **Stack:** React 19 + Vite + MUI, TanStack Router + TanStack Query.
- **API client:** **generated** from the webapi OpenAPI spec into
  `src/api/generated.ts` (orval, `bun run gen:clients`) — not hand-written.

## Layout

- `src/main.tsx` — mounts the app (QueryClient + MUI theme + TanStack Router).
- `src/router.tsx` — code-based route tree (`/` list, `/sessions/$id` detail),
  `basepath: "/app"`.
- `src/api/generated.ts` — the orval snapshot (fetchers + react-query hooks).
- `src/routes/` — `root` (shell), `sessions-list`, `session-detail`.
- `src/components/` — `TranscriptView` (lazy-paged), `StatusChip`,
  `TokenUsageChips`, shared `states`.
- `src/format.ts`, `src/transcript-entry.ts` — pure presentation helpers.

Built (Tier 1): paginated session list (with duration, start-path, and
live/backfilled source columns), session detail with metadata + token / tool
breakdown, a lazy transcript viewer (each entry previews, expands to raw JSON),
and a header Services menu (placeholder links). Still planned: virtual scroll,
making the Services menu config-driven from the `/` app manifest, local-first
cache, keyboard nav. The theme is a light baseline; a dark variant and the full
visual pass are deferred per the roadmap. See docs/webui.md.

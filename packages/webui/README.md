# @claude-transcripts/webui

The viewer — a React SPA over the webapi. **Optional** interface (everything is
reachable via the CLI/API). Served at `/app` by the combined image in prod; in dev
Vite serves it on `7651` and proxies `/api` → webapi on `7650`.

- **Stack:** React 19 + Vite + MUI, TanStack Router + TanStack Query.
- **API client:** **generated** from the webapi OpenAPI spec into
  `src/api/generated.ts` (orval, `bun run gen:clients`) — not hand-written. The
  lone exception is `src/api/model.ts` (`GET /api/model`, a non-OpenAPI route).

## Layout

- `src/main.tsx` — mounts the app (QueryClient + ColorModeProvider + Router).
- `src/color-mode.tsx` / `src/theme.ts` — light/dark theme + persisted mode.
- `src/router.tsx` — code-based route tree (`/` list, `/sessions/$id` detail),
  `basepath: "/app"`.
- `src/api/generated.ts` — the orval snapshot (fetchers + react-query hooks).
- `src/routes/` — `root` (shell), `sessions-list`, `session-detail`.
- `src/components/` — `Header` (title/version, search, settings, links menus),
  `SearchBox`, `SettingsMenu`, `LinksMenu`, `TranscriptView` (lazy-paged),
  `StatusChip`, `SourceChip`, `TokenUsageChips`, shared `states`.
- `src/format.ts`, `src/transcript-entry.ts` — pure presentation helpers.

Built (Tier 1): a thin header (title + build version, placeholder search box,
theme toggle, and a links menu for services/API/GitHub/docs); a stats-focused
paginated session list (duration, project, live/backfilled source, counts,
status); session detail with metadata + token / tool breakdown + the full
start-path; and a lazy transcript viewer (each entry previews, expands to raw
JSON). Light + dark themes (persisted, follow-system default). Still planned:
wiring search to Meilisearch, virtual scroll, making the links menu config-driven
from `/api/model`, local-first cache, keyboard nav. The full visual pass is
deferred per the roadmap. See docs/webui.md.

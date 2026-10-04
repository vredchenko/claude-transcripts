# @claude-transcripts/webui

The viewer — a React SPA over the webapi. **Optional** interface (everything is
reachable via the CLI/API). Served at `/app` by the combined image in prod; in dev
Vite serves it on `7651` and proxies `/api` → webapi on `7650`.

- **Stack:** React 19 + Vite + MUI, TanStack Router + TanStack Query.
- **API client:** **generated** from the webapi OpenAPI spec into
  `src/api/generated.ts` (orval, `bun run gen:clients`) — not hand-written. The
  lone exception is `src/api/blueprint.ts` (`GET /api/model`, a non-OpenAPI route).

## Layout

- `src/main.tsx` — mounts the app (QueryClient + ThemeProvider + Router).
- `src/theme.ts` — the one (dark) theme.
- `src/nav-menus.ts` — the header menus, projected from `/api/model`.
- `src/router.tsx` — code-based route tree (`/` list, `/sessions/$id` detail,
  `/search` results), `basepath: "/app"`.
- `src/api/generated.ts` — the orval snapshot (fetchers + react-query hooks).
- `src/routes/` — list, detail, `/search` results.
- `src/components/` — header + omnibox, menus, transcript readers, chips; `sessions/`
  holds the list + calendar.
- `src/omnibox/`, `src/hooks/` — omnibox parser/storage; infinite-scroll hooks.
- `src/*.ts` — pure presentation helpers.
- `dev/` — finds the webapi to proxy to.

Feature status and what's planned (virtual scroll, local-first cache):
[docs/reference/webui.md](../../docs/reference/webui.md).

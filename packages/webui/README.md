# @claude-transcripts/webui

The viewer: a React single-page app over the webapi. **Optional** (everything it shows
is reachable via the CLI and the API). Served at `/app` by the combined image in prod;
in dev Vite serves it on `7651` and proxies `/api` to the webapi on `7650`.

What it does, from the reader's side: [docs/use/web-ui.md](../../docs/use/web-ui.md).
This page is about the code.

```bash
bun run dev:webui     # http://127.0.0.1:7651/app/, proxies /api to the webapi
bun run build         # → packages/webui/dist/, served via CT_STATIC_DIR
```

- **Stack:** React 19, Vite 6, MUI 6, TanStack Router and TanStack Query.
- **API client:** **generated** from the webapi OpenAPI spec into
  `src/api/generated.ts` (orval, `bun run gen:clients`), not hand-written. The lone
  exception is `src/api/blueprint.ts` (`GET /api/blueprint`, a non-OpenAPI route).

## Code

| Path (`src/`) | Holds |
|---------------|-------|
| `main.tsx`, `router.tsx` | Root: Query client (30 s `staleTime`, no refetch on focus, `retry: 1`), the theme, code-based router with basepath `/app`. Each route validates its own query-string state and falls back to defaults. |
| `theme.ts` | The one (dark) MUI theme; components use semantic palette tokens. |
| `nav-menus.ts` | The header menus and a session's data links, projected from `/api/blueprint`. |
| `api/generated.ts` | orval output: types, fetchers, query-key helpers, React Query hooks. Never edit; `bun run gen:clients`. |
| `api/http.ts` | The orval mutator: same-origin requests, unwraps the body, throws `ApiRequestError` on non-2xx. |
| `api/blueprint.ts` | Hand-written `useAppBlueprint` for `/api/blueprint`, which is not in the OpenAPI spec. |
| `routes/` | `root`, `sessions-list` (`/`), `session-detail` (`/sessions/$id`), `search-results` (`/search`). |
| `components/` | UI; `components/sessions/` holds the list and calendar. |
| `omnibox/` | Input parsing, `>` commands, recent searches, saved filters. |
| `hooks/` | Infinite paging for the list and transcript, and the scroll sentinel. |

`dev/` (beside `src/`) finds the webapi to proxy to.

Logic worth testing lives in pure modules: `format.ts`, `search-query.ts`,
`sessions-view.ts`, `transcript-entry.ts`, `transcript-timeline.ts`, `omnibox/parse.ts`.

When passing `queryKey` explicitly, use the generated helpers
(`getListSessionsQueryKey(params)`); a hand-made key splits the cache. orval generates
`useQuery` hooks only, so infinite lists wrap the raw fetchers
(`useInfiniteSessionList`, `useInfiniteTranscript`).

## Where the data comes from

- The session list passes its filters (`cwd`, `model`, `hostname`, `source`,
  `from`/`to`) straight to `GET /api/sessions` as URL parameters.
- The User and Claude transcript views read `GET /api/sessions/{id}/turns`; Both reads
  the paged transcript entries, and the Timeline and Raw readers are two renderings of
  the same entries.
- The header (title, build version, the Services / Dev / About menus) is projected from
  `/api/blueprint` in `src/nav-menus.ts`. The Services menu takes its admin UIs from
  `servicesMenu` and reads each CouchDB database's design views live through the
  read-only proxy; Fossil timelines come through `/api/fossil`. `servicesMenu` links no
  service claims appear under **Other**. The Dev menu lists the gateway routes the
  blueprint marks for it (`RouteDef.nav`), plus a placeholder for the Claude Code
  plugin. About derives the project links from `identity.repository`.
- The transcript list isn't virtualised, which is why loading stops at
  `userSettings.transcriptAutoLoadMax` and offers a button for the rest.

## Dev server

`vite.config.ts` loads the repo-root `.env` for `WEBUI_HOST`/`WEBUI_PORT` and the proxy
target. `dev/webapi-target.ts` picks the target the same way the CLI does: `WEBAPI_PORT`
if set, else the installed instance's port from `instance.env`, else 7650. When nothing
is listening, proxied calls return 502 with a body naming the dead target.

## Planned

Virtualised lists (which would remove the `transcriptAutoLoadMax` ceiling),
configurable columns, server-side sorting of the session list (a `sort`/`dir` parameter
on `GET /api/sessions`), a cross-session view over `/api/turns`, keyboard navigation,
and a visual design pass.

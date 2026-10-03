# webui

`packages/webui/`: a React single-page app for browsing history, served by the webapi
at `/app`. Optional; everything it shows is reachable through the API and CLI. Stack:
React 19, Vite 6, MUI 6, TanStack Router and TanStack Query, with an orval-generated
API client.

```bash
bun run dev:webui     # http://127.0.0.1:7651/app/, proxies /api to the webapi
bun run build         # → packages/webui/dist/, served via CT_STATIC_DIR
```

## Pages

- **Sessions** (`/`) — two views, chosen in the URL (`/?view=calendar&month=2026-03`):
  - **List** (default): grouped by day, newest first, infinite scroll. Each row shows
    start time, project and full `cwd`, runtime with an active/idle bar, host and model,
    top tools, tokens, a status chip and a copy-id button. Columns are not sortable.
  - **Calendar**: one month as 24-hour lanes per day, bars placed by clock time and
    coloured per project, opacity showing the active share.

  Filters (`cwd`, `model`, `hostname`, `source`, `from`/`to`) are URL parameters passed
  to `GET /api/sessions`, shown as removable chips.
- **Session detail** (`/sessions/$id`) — metadata (start, total runtime, active and
  idle time, model, host, recording source, end reason, counts, transcript size),
  working directory, token usage, tool calls, and the transcript viewer.
- **Search results** (`/search`) — paged, filterable by project, model, host and
  provenance, with all state in the query string.

Status chips read **live** (running), **abandoned** (incomplete) or **ended**;
provenance chips read **live** or **backfilled**. Active time is runtime minus gaps
longer than `system.sessions.idleThresholdMs`; it shows `—` where the API couldn't
derive it.

### Transcript viewer

A **Both / You / Claude** toggle picks the speaker. You or Claude shows one side of
the conversation from `GET /api/sessions/{id}/turns` (empty without full-content
chunks). Both shows the full transcript in one of two readers over the same paged
entries:

- **Timeline** (default): dialogue turns only, labelled You / Claude with times, tools
  called and a subagent chip. Runs of tool calls, results, attachments and system lines
  fold into one line (`› 12 lines · Read ×3, Bash`) that opens in place.
  `<system-reminder>` blocks are hidden from turn text.
- **Raw**: every stored entry on one line, expanding to its text or JSON.

Entries load in blocks of `userSettings.transcriptPageSize` as you scroll and in the
background while the tab is visible. After `userSettings.transcriptAutoLoadMax`
entries a button offers to load the rest, because the list isn't virtualised. Arriving
from search (`?q=`) opens at the matching entry with terms highlighted.

### Header

Title and build version (from `/api/model`), the omnibox, a settings menu (light / dark /
system theme, stored in `localStorage`) and a links menu (API docs, OpenAPI spec,
`/api/model`, the backing services' admin UIs from `servicesMenu`, the repo, the docs).

The omnibox takes free text, `project:` / `host:` / `model:` / `source:` operators, date
phrases, an id prefix or `>` commands. Enter filters the list, Shift+Enter searches,
Ctrl/Cmd+K focuses it. Its dropdown previews search hits, recent searches and saved
filters, and shows a hint when search is off.

## Code

| Path (`src/`) | Holds |
|---------------|-------|
| `main.tsx`, `router.tsx` | Root: Query client (30 s `staleTime`, no refetch on focus, `retry: 1`), colour mode, code-based router with basepath `/app`. Each route validates its own query-string state and falls back to defaults. |
| `color-mode.tsx`, `theme.ts` | Light/dark/system mode and the MUI theme; components use semantic palette tokens. |
| `api/generated.ts` | orval output: types, fetchers, query-key helpers, React Query hooks. Never edit; `bun run gen:clients`. |
| `api/http.ts` | The orval mutator: same-origin requests, unwraps the body, throws `ApiRequestError` on non-2xx. |
| `api/model.ts` | Hand-written `useAppModel` for `/api/model`, which is not in the OpenAPI spec. |
| `routes/` | `root`, `sessions-list`, `session-detail`, `search-results`. |
| `components/` | UI; `components/sessions/` holds the list and calendar. |
| `omnibox/` | Input parsing, `>` commands, recent searches, saved filters. |
| `hooks/` | Infinite paging for the list and transcript, and the scroll sentinel. |

Logic worth testing lives in pure modules: `format.ts`, `search-query.ts`,
`sessions-view.ts`, `transcript-entry.ts`, `transcript-timeline.ts`, `omnibox/parse.ts`.

When passing `queryKey` explicitly, use the generated helpers
(`getListSessionsQueryKey(params)`); a hand-made key splits the cache. orval generates
`useQuery` hooks only, so infinite lists wrap the raw fetchers
(`useInfiniteSessionList`, `useInfiniteTranscript`).

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

# webui — codebase reference

The **viewer**: a React single-page app for browsing session history. It is a
thin read client over the [webapi](webapi.md) — list, detail, and a transcript
viewer — and is deliberately minimal in Tier 1 (functional, lightly styled; a
visual rework is future scope, [#8](../design/roadmap.md)). It stays **optional** —
everything it does is reachable via the CLI/API ([tiers.md](../design/tiers.md)).

- **Package:** `packages/webui/` (workspace name `@claude-transcripts/webui`)
- **Stack:** React 19 + Vite 6 + MUI 6 (Emotion), TanStack Query 5, **TanStack
  Router**, TypeScript (ESM, strict). No separate state library — routing holds
  the navigational state and TanStack Query holds the server state.
- **Theme:** a restrained **light** baseline is the primary target, with a
  parallel **dark** palette. `theme.ts` exposes `createAppTheme(mode)` +
  `codeBg(mode)` + the `MONO` stack; `color-mode.tsx` owns the mode (a persisted
  light / dark / follow-system preference) and provides the `ThemeProvider`.
  Components read semantic tokens (`primary.main`, `divider`, …) so both modes work
  without per-component color hardcoding.
- **API client:** **generated** from the webapi OpenAPI spec into
  `src/api/generated.ts` (orval, `bun run gen:clients`;
  [ADR 0019](../design/decisions/0019-openapi-source-of-truth-generated-clients.md), which
  supersedes the original [0006](../design/decisions/0006-no-openapi-client-codegen-shared-types.md)
  "no codegen" stance) — not hand-written.
- **Build output:** `dist/` — served by the webapi under `/app` in production.

## What's built (Tier 1)

- **Session list** (`/`) in three **projections**, chosen from a toggle and recorded
  in the URL (`/?view=calendar&month=2026-03`) so a view is linkable and the back
  button steps through them:
  - **Table** — the dense, comparative view: per-column summary metrics including
    **runtime / active / idle**, the **project** and the **host** it ran on, and a
    **source** chip.
  - **Timeline** — vertical, grouped by day, at one of three densities: `cards`
    (full detail per session, with a duration bar whose filled part is the active
    time), `compact` (one line each), and `to scale` (positioned by real elapsed
    time, so the gaps between sessions are visible).
  - **Calendar** — a month grid drawing each session as a bar across **every day it
    covers** (a session here can run for days), and a day view placing sessions by
    clock time with concurrent ones side by side. A calendar bar's length *is* the
    wall-clock span, so the active/idle split is told in the bar's caption and its
    tooltip rather than by shading part of the bar — idle time is scattered through a
    session, not parked at one end of it.

  All three read **active vs idle** time from the same `activeMs` field: wall-clock
  runtime minus gaps longer than the configured idle threshold, so a session left open
  in tmux over a weekend reads as the twenty minutes of work it was.
- **Session detail** (`/sessions/$id`) — metadata grid (with duration + recording
  source), token-usage breakdown, tool-call chips. The full start-path lives here
  (as "Working directory") rather than in a list column.
- A **transcript viewer** that pages entries incrementally; each entry previews
  on one line and expands to raw JSON.
- **Full-text search** with the matched terms **marked** — in the header dropdown,
  on the results page, and carried into the session (`?q=`), which opens on the
  matching entry rather than at the top of a five-thousand-entry transcript.
- A **thin header** (`Header.tsx`): app title + build version (from `/api/model`),
  the **search box**, a **settings** menu (theme toggle: light / dark /
  follow-system), and a **links** menu (services, API, GitHub repo, tech docs).

## Still planned

- **Virtual scroll + configurable columns** for the long lists/transcripts —
  evaluate an existing npm dep (e.g. TanStack Virtual / `react-virtuoso`) rather
  than rolling our own; the transcript viewer already pages, this generalises it
  ([#8](../design/roadmap.md)).
- **Local-first browser caches** *(nice-to-have)* — persist the TanStack Query
  cache (e.g. IndexedDB) so revisits are instant and partially offline.
- **Keyboard navigation** *(nice-to-have)* — list/detail/transcript navigable
  without the mouse.
- **The visual/design pass** is deferred per the roadmap; the current theme is a
  restrained dark baseline.

## File layout

```
packages/webui/
├── index.html                 # Vite HTML entry (#root + module script)
├── vite.config.ts             # React plugin, base "/app/", dev server, /api proxy
├── dev/
│   └── webapi-target.ts       # dev-only (Node): find the webapi, explain it if absent
└── src/
    ├── main.tsx               # React root: QueryClient + ColorModeProvider + Router
    ├── color-mode.tsx         # color-mode state (light/dark/system) + ThemeProvider
    ├── router.tsx             # code-based TanStack Router tree (basepath "/app")
    ├── theme.ts               # createAppTheme(mode) + codeBg(mode) + MONO stack
    ├── format.ts              # pure presentation helpers (no React)
    ├── search-query.ts        # pure: /search URL state → API params, paging maths
    ├── sessions-view.ts       # pure: interval/day/month maths for timeline + calendar
    ├── transcript-entry.ts    # raw JSONL entry → compact EntryView
    ├── api/
    │   ├── generated.ts       # orval snapshot: types + fetchers + query hooks
    │   ├── http.ts            # orval mutator: unwrap + throw on non-2xx
    │   └── model.ts           # hand-written GET /api/model hook (header title/version)
    ├── routes/
    │   ├── root.tsx           # RootLayout app shell (Header + Outlet)
    │   ├── sessions-list.tsx  # SessionsListPage — "/", switches the three projections
    │   ├── session-detail.tsx # SessionDetailPage — "/sessions/$id" (+ ?q= highlight)
    │   └── search-results.tsx # SearchResultsPage — "/search" (filters + paging)
    └── components/
        ├── Header.tsx         # thin top bar (title/version, search, settings, links)
        ├── SearchBox.tsx      # header search input → GET /api/search (sessions + content)
        ├── HighlightedText.tsx# renders marked snippets / query terms as <mark>
        ├── SettingsMenu.tsx   # primary menu: theme toggle (+ config later)
        ├── LinksMenu.tsx      # secondary menu: services / API / GitHub / docs links
        ├── TranscriptView.tsx # incrementally-paged transcript accordion
        ├── SpeakerTurnsView.tsx # one side of the conversation (You / Claude)
        ├── StatusChip.tsx     # session lifecycle chip (live / abandoned / ended)
        ├── SourceChip.tsx     # recording provenance chip (live / backfilled)
        ├── TokenUsageChips.tsx# token breakdown chips
        ├── states.tsx         # Loading / ErrorState / EmptyState
        └── sessions/          # the three projections of the session list
            ├── SessionsTable.tsx     # dense comparative table
            ├── SessionsTimeline.tsx  # vertical timeline, three densities
            └── SessionsCalendar.tsx  # month grid (day-spanning bars) + day time-grid
```

The **pure** modules (`format.ts`, `search-query.ts`, `sessions-view.ts`,
`transcript-entry.ts`) hold the logic worth unit-testing, out of the components: paging
offsets and calendar placement are where the silent bugs live, and a component test
would not catch a session drawn on the wrong day.

## Bootstrap & routing

`src/main.tsx` mounts the app into `#root` under `StrictMode`: a
`QueryClientProvider` (30s `staleTime`, no refetch-on-focus, `retry: 1`), the
`ColorModeProvider` (which supplies the MUI `ThemeProvider` + `CssBaseline` for the
active mode and persists the user's light/dark/system preference in
`localStorage`), and a `RouterProvider`.

`src/router.tsx` builds a **code-based** TanStack Router tree (no file-based
plugin): a `RootLayout` root route with three children — `/` → `SessionsListPage`,
`/sessions/$id` → `SessionDetailPage`, and `/search` → `SearchResultsPage`. Each
validates the query-string state it owns (the list's `view`/`density`/`month`/`day`,
the detail's `q`, the results page's `q`/filters/`page`), falling back to defaults
rather than rendering nothing — that state arrives from whatever was pasted into the
address bar. The router is created with
`basepath: "/app"` because the SPA is served under `/app` in production
([ADR 0002](../design/decisions/0002-single-combined-container.md)), matching Vite's
`base: "/app/"`. `RootLayout` (`routes/root.tsx`) is the shell: the sticky
`Header` over a `Container` that renders the routed `<Outlet />`.

## API layer (`api/generated.ts`)

The generated snapshot is the single source of client types and data hooks. It
is overwritten by `bun run gen:clients` — **do not edit by hand**. Transport lives in
`api/http.ts`, the orval **mutator**: it unwraps orval's `{data, status, headers}`
envelope and throws an `ApiRequestError` (message + `status`) on a non-2xx, so
react-query's `isError`/`error` work as they should. Requests are same-origin — the
webui is served under `/app` with `/api` proxied to the webapi — so nothing is
prepended to the spec's own `/api/...` paths.

It exports:

- **Types**, named after the spec's component schemas — `TokenUsage`,
  `SessionStatus` (`ended | running | incomplete`), `SessionSummary`,
  `SessionsResponse`, `TranscriptEntry`, `TranscriptResponse`, `SpeakerTurn`,
  `SearchResponse`, `ApiError`, and the param shapes.
- **Fetchers** — `listSessions`, `getSession`, `getSessionTranscript`, …
- **Query-key helpers** — `getListSessionsQueryKey(params)` and friends. Use these
  when passing `queryKey` explicitly; inventing a key splits the cache from every
  other caller of the same route.
- **React Query hooks** (consumed by the views):
  - `useListSessions({ limit, skip })` → `GET /api/sessions` — the list.
  - `useGetSession(id)` → `GET /api/sessions/{id}` — detail (disabled until `id`).
  - `useGetSessionTranscript(id, { limit, offset })` →
    `GET /api/sessions/{id}/transcript` — paged for the viewer's "Load more".

Hook options are nested: react-query options go under `query`, per-call fetch options
under `request` — `useListSessions(params, { query: { placeholderData: … } })`.

All requests are relative (`/api/...`); in dev Vite proxies them to the webapi.

The one hand-written client is `api/model.ts` (`useAppModel` → `GET /api/model`):
that endpoint is a plain Hono route, not part of the OpenAPI contract, so it isn't
in the generated snapshot. The header uses it for the title + build version.

## Views

- **`SessionsListPage`** (`routes/sessions-list.tsx`) — fetches a page
  (`PAGE = 50`) and renders a stats-focused MUI table: session id (first 8 chars,
  linked to detail), **started** time (session start), **runtime** (wall-clock) split
  into **active** and **idle**, **project** (trailing `cwd` segment, full path on
  hover), **host** (the machine that recorded it, next to the project — the same
  project name on two machines is two different working copies), model, a **source**
  chip (live / backfilled), prompt / event / tool counts, total tokens, transcript
  size, and a **status** chip. Active time comes from `activeMs` on the API response;
  where the gateway can't derive it the two split columns read `—` rather than `0s`. The full start-path is intentionally *not* a column (too long) —
  it's on the detail view; the list stays compact. Paging is Previous/Next over a
  `skip` offset with a "N–M of total" label; `placeholderData: (prev) => prev`
  keeps the current page visible (dimmed) while the next loads. Every row links to
  its detail.
- **`SessionDetailPage`** (`routes/session-detail.tsx`) — reads `$id` from the
  route, fetches one summary, and renders a back link, the id + status chip, a
  metadata grid (started, **total runtime**, **active** + **idle** time, model,
  hostname, **recording** source,
  end reason, prompt / event / error counts, transcript size), the working
  directory, a **Token usage** row (`TokenUsageChips`), and a **Tool calls** chip
  set sorted by count. Mounts `TranscriptView` when `hasTranscript`, else shows a
  "no transcript was stored" note.
- **`Header`** (`components/Header.tsx`) — the thin top bar. Left: app title +
  build version (from `GET /api/model` via `api/model.ts`, with a "Claude
  Transcripts" fallback while loading). Center: `SearchBox` — a debounced
  full-text search over `GET /api/search`, showing both **session** matches (project,
  id, model) and **in-conversation** matches (a cropped snippet with the matched terms
  **marked**, plus a role chip); selecting either navigates to that session, carrying
  the query so it opens on the match. Degrades to a hint when
  Meilisearch is disabled or unreachable rather than erroring. Below `sm` the toolbar
  wraps and the search takes its own full-width row — squeezing it onto one line left
  an unusable sliver pressed against the settings button. Right: `SettingsMenu` (a ⚙ button — the theme toggle
  light / dark / follow-system, plus a disabled "config coming soon") and
  `LinksMenu`.
- **`LinksMenu`** (`components/LinksMenu.tsx`) — the secondary dropdown grouping
  quick links: **This app** (Scalar `/api/docs`, OpenAPI spec, `/api/model`);
  **Services** (CouchDB Fauxton + a `_all_docs` JSON link, Garage Web UI + buckets,
  Meilisearch UI + API); **Project** (GitHub repo, tech docs → the repo's `docs/`).
  The service URLs come from `/api/model`'s `servicesMenu`, so they follow the
  deployment's real ports and hosts rather than the bundled dev defaults.
- **`StatusChip`** (`components/StatusChip.tsx`) / **`SourceChip`**
  (`components/SourceChip.tsx`) — the lifecycle chip (labels: **live** /
  **abandoned** / **ended**, each with an explanatory tooltip) and the provenance
  chip (**live** vs **backfilled**), both used by the list and detail views.
- **`TranscriptView`** (`components/TranscriptView.tsx`) — pages the transcript
  in blocks of `PAGE = 100` from `offset: 0`, growing `limit` on "Load more" so
  entries accumulate (again with `placeholderData` to avoid flicker). Each entry
  is an accordion: the summary shows its index, a kind chip (user / assistant /
  system / summary, color-coded), a **subagent** chip for sidechain entries, an
  **error** chip when the entry carries a tool error, and a one-line preview; the
  details pane shows the raw entry as pretty-printed JSON. (Virtual scrolling is
  the planned follow-up; incremental paging keeps long transcripts responsive.)
- **Shared states** (`components/states.tsx`) — `Loading` (centered spinner),
  `ErrorState` (MUI alert with the thrown message), and `EmptyState`.

## Presentation helpers

- **`format.ts`** — pure, dependency-free: `formatBytes` (1024-based),
  `formatCount` (grouped integer), `formatTimestamp` (ISO → local
  `YYYY-MM-DD HH:MM`), `formatDuration` (ms → `1h 2m` / `3m 4s` / `5s`),
  `durationSplit` / `durationSplitLabel` (wall-clock → active + idle, defensive about
  an active figure that overshoots the runtime and about one that was never derived),
  `projectName` (trailing `cwd` segment),
  `totalTools` (sum of a tool-count map).
- **`transcript-entry.ts`** — `summarizeEntry(entry)` interprets a raw Claude
  Code JSONL entry into an `EntryView` (`kind`, one-line `preview`, `sidechain`,
  `isError`). It is defensive by design: the webapi passes entries through
  verbatim, so unknown shapes still render (as raw JSON) rather than throwing.
- **`theme.ts`** — a restrained dark MUI theme (backgrounds `#0e1116`/`#161b22`,
  primary `#58a6ff`) plus the exported `MONO` font stack used for ids, paths, and
  transcript JSON.

## Build & dev (`vite.config.ts`)

- Loads the **repo-root `.env`** (shared with the webapi) for `WEBUI_HOST/PORT`
  and the `WEBAPI_HOST/PORT` proxy target.
- Sets `base: "/app/"` so dev matches the production mount point.
- Dev server defaults to `127.0.0.1:7651`, proxying `/api` (`changeOrigin: true`).
- **Finding the webapi** (`dev/webapi-target.ts`) — the proxy target is, in order:
  `WEBAPI_PORT` when set, else the **installed instance's** `instance.env`, else
  `7650`. `install` allocates a port per instance, so a checkout run alongside an
  install would otherwise proxy to a port nothing listens on. Only the *port* pins
  the target; `WEBAPI_HOST` just chooses the host for it, because the template ships
  a `WEBAPI_HOST` and it must not suppress the lookup. This mirrors the CLI's
  `resolveWebapiUrl` — a checkout's two clients should agree on where the webapi is.
- **When nothing is listening**, the target is reported at startup and failed proxy
  calls return **502** with a `{ error, detail }` body naming the dead origin and the
  live instance to use instead. Vite's own handler would return a bodiless 500, which
  reads as an application bug rather than a missing upstream.
- `bun run build` (root) outputs `packages/webui/dist/`, which the production
  image copies and the webapi serves via `CT_STATIC_DIR`
  ([ADR 0002](../design/decisions/0002-single-combined-container.md)).

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
  parallel **dark** palette. `theme.ts` exposes `createAppTheme(mode)` + the
  `MONO` stack (code surfaces read `theme.palette.code.bg`); `color-mode.tsx` owns
  the mode (a persisted light / dark / follow-system preference) and provides the
  `ThemeProvider`.
  Components read semantic tokens (`primary.main`, `divider`, …) so both modes work
  without per-component color hardcoding.
- **API client:** **generated** from the webapi OpenAPI spec into
  `src/api/generated.ts` (orval, `bun run gen:clients`;
  [ADR 0019](../design/decisions/0019-openapi-source-of-truth-generated-clients.md), which
  supersedes the original [0006](../design/decisions/0006-no-openapi-client-codegen-shared-types.md)
  "no codegen" stance) — not hand-written.
- **Build output:** `dist/` — served by the webapi under `/app` in production.

## What's built (Tier 1)

- **Session list** (`/`) in two **projections**, chosen from a toggle and recorded
  in the URL (`/?view=calendar&month=2026-03`) so a view is linkable and the back
  button steps through them:
  - **List** (the default) — a day-grouped grid, newest first, with per-row
    **runtime** and an active/idle bar, the **project** and the **host** it ran on,
    tool mix, tokens and a **status** chip.
  - **Calendar** — one month as a stack of 24-hour lanes, one per day on which a
    session started; bars are placed by clock time (clipped at midnight), coloured per
    project, and their opacity reflects the active share. ‹ › and **Today** move
    between months.

  Both read **active vs idle** time from the same `activeMs` field: wall-clock
  runtime minus gaps longer than the configured idle threshold, so a session left open
  in tmux over a weekend reads as the twenty minutes of work it was.
- **Session detail** (`/sessions/$id`) — metadata grid (with duration + recording
  source), token-usage breakdown, tool-call chips. The full start-path lives here
  (as "Working directory") rather than in a list column.
- A **transcript viewer** with two readers over the same paged entries: a
  **conversation timeline** (the default) showing only dialogue turns and folding
  every run of tool calls, tool results, attachments and system lines into one
  openable line; and the **raw** list, where every stored entry previews on one line
  and expands to raw JSON.
- **Full-text search** with the matched terms **marked** — in the header dropdown,
  on the results page, and carried into the session (`?q=`), which opens on the
  matching entry rather than at the top of a five-thousand-entry transcript.
- A **thin header** (`Header.tsx`): app title + build version (from `/api/model`),
  the **omnibox**, a **settings** menu (theme toggle: light / dark /
  follow-system), and a **links** menu (services, API, GitHub repo, tech docs).

## Still planned

- **Virtual scroll + configurable columns** for the long lists/transcripts —
  evaluate an existing npm dep (e.g. TanStack Virtual / `react-virtuoso`) rather
  than rolling our own ([#8](../design/roadmap.md)). Both surfaces now page and
  scroll-load; what's missing is windowing the DOM, which is what would let the
  transcript drop its `transcriptAutoLoadMax` ceiling entirely.
- **Sorting the session list** — would need `sort`/`dir` on `GET /api/sessions`
  (the handler already materialises and sorts the whole filtered set in memory before
  slicing, so it's a comparator swap) plus a flat, ungrouped rendering for any order
  that isn't chronological. Not client-side: with infinite scroll that only ever sorts
  the pages already fetched.
- **Local-first browser caches** *(nice-to-have)* — persist the TanStack Query
  cache (e.g. IndexedDB) so revisits are instant and partially offline.
- **Keyboard navigation** *(nice-to-have)* — list/detail/transcript navigable
  without the mouse.
- **The visual/design pass** is deferred per the roadmap; the current theme is a
  restrained light baseline with a parallel dark palette.

## File layout

Under `packages/webui/`: `vite.config.ts` (base `/app/`, dev server, `/api` proxy) and
`dev/webapi-target.ts` (dev-only webapi discovery). Under `src/`:

| Path | Holds |
|------|-------|
| `main.tsx`, `router.tsx`, `color-mode.tsx`, `theme.ts` | React root, TanStack Router tree (basepath `/app`), colour mode + theme |
| `api/` | orval-generated client (`generated.ts`), its mutator (`http.ts`), the hand-written `/api/model` hook (`model.ts`) |
| `routes/` | One page per route: `root`, `sessions-list`, `session-detail`, `search-results` |
| `components/` | UI; `components/sessions/` holds the two list projections |
| `omnibox/` | Header input parsing, `>` commands, recent searches + saved filters |
| `hooks/` | Infinite paging (session list, transcript) + the scroll sentinel |
| `*.ts` at the top level | Pure helpers (below) |

The **pure** modules (`format.ts`, `search-query.ts`, `sessions-view.ts`,
`transcript-entry.ts`, `transcript-timeline.ts`, `omnibox/parse.ts`) hold the logic worth unit-testing, out
of the components: paging offsets, calendar placement and "is this line dialogue?" are
where the silent bugs live, and a component test would not catch a session drawn on the
wrong day or a turn quietly folded out of sight.

## Bootstrap & routing

`src/main.tsx` mounts the app into `#root` under `StrictMode`: a
`QueryClientProvider` (30s `staleTime`, no refetch-on-focus, `retry: 1`), the
`ColorModeProvider` (which supplies the MUI `ThemeProvider` + `CssBaseline` for the
active mode and persists the user's light/dark/system preference in
`localStorage`), and a `RouterProvider`.

`src/router.tsx` builds a **code-based** TanStack Router tree (no file-based
plugin): a `RootLayout` root route with three children — `/` → `SessionsListPage`,
`/sessions/$id` → `SessionDetailPage`, and `/search` → `SearchResultsPage`. Each
validates the query-string state it owns (the list's `view`/`month`/`day` and its
filters, the detail's `q`, the results page's `q`/filters/`page`), falling back to defaults
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
    `GET /api/sessions/{id}/transcript` — the single-page hook. The viewer instead
    wraps the raw `getSessionTranscript` fetcher in `useInfiniteTranscript`, since
    orval's react-query generator emits `useQuery` only (same reason
    `useInfiniteSessionList` wraps `listSessions`).

Hook options are nested: react-query options go under `query`, per-call fetch options
under `request` — `useListSessions(params, { query: { placeholderData: … } })`.

All requests are relative (`/api/...`); in dev Vite proxies them to the webapi.

The one hand-written client is `api/model.ts` (`useAppModel` → `GET /api/model`):
that endpoint is a plain Hono route, not part of the OpenAPI contract, so it isn't
in the generated snapshot. The header uses it for the title + build version.

## Views

- **`SessionsListPage`** (`routes/sessions-list.tsx`) — the default projection: a
  day-grouped CSS grid (`components/sessions/SessionsList.tsx`), not a table. Each day
  gets a header with its rollup (session count, active time, tokens); each row carries
  clock time, **project** (trailing `cwd` segment, full path on hover) over the full
  `cwd`, **runtime** with an active/idle bar, **host** over model (the machine that
  recorded it — the same project name on two machines is two different working copies),
  the top-2 **tool mix**, total **tokens** over turn/tool counts, a **status** chip, and
  a copy-id button. Active time comes from `activeMs` on the API response; where the
  gateway can't derive it the split reads `—` rather than `0s`. Every row links to its
  detail.

  **Paging is infinite scroll**, not Previous/Next: `useInfiniteSessionList` accumulates
  `skip` pages and `useIntersectionObserver` fires the next one 600px before the reader
  reaches the end. Page size is `userSettings.sessionListPageSize` (default 100) and is
  part of the query key, so changing the config starts a fresh list rather than appending
  differently-sized pages.

  **Filters are query params on `GET /api/sessions`, not a client-side sieve.** The
  URL carries `cwd`, `model`, `hostname`, `source` (exact match, the same four
  attributes `/api/search` filters on) and `from`/`to` (range overlap); each renders as
  a deletable chip and each is forwarded to the gateway by both projections. Filtering
  client-side was never an option: the list is infinite-scrolled, so a filter applied
  to the loaded pages would narrow the first page and let the next arrive unfiltered
  underneath it, and the "N of M shown" count would still be counting the whole corpus.
  The omnibox's `project:` / `host:` / `model:` / `source:` operators navigate here by
  setting those params. With a filter active and nothing matching, the empty state says
  so rather than claiming nothing has been recorded.

  **The column headings are labels, not controls.** They were briefly sortable, but the
  list is grouped by day and `groupByDay` re-sorts each group by start time, so the
  chosen order never reached the screen — the arrow moved and the rows didn't. A sort
  over only the pages fetched so far would have been misleading anyway, with the next
  page arriving underneath it in server order. The list has one order, newest first; a
  real sort would have to be a `sort`/`dir` param on `GET /api/sessions` (the handler
  already materialises and sorts the whole filtered set before slicing).
- **`SessionsCalendar`** (`components/sessions/SessionsCalendar.tsx`) — the other
  projection (above); fetches the whole month in one call (`CALENDAR_LIMIT = 500`).
- **`SessionDetailPage`** (`routes/session-detail.tsx`) — reads `$id` from the
  route, fetches one summary, and renders a back link, the id + status chip, a
  metadata grid (started, **total runtime**, **active** + **idle** time, model,
  hostname, **recording** source,
  end reason, prompt / event / error counts, transcript size), the working
  directory, a **Token usage** row (`TokenUsageChips`), and a **Tool calls** chip
  set sorted by count. Mounts `TranscriptView` when `hasTranscript`, else shows a
  "no transcript was stored" note.
- **`Header`** (`components/Header.tsx`) — title + version (`GET /api/model`), the
  `Omnibox`, `SettingsMenu` (theme toggle) and `LinksMenu`. The omnibox
  (`omnibox/parse.ts`) takes text, `project:` / `host:` / `model:` / `source:`
  operators, date phrases, an id prefix or `>` commands. **Enter** filters the list,
  **Shift+Enter** searches, Ctrl/Cmd+K focuses. Its dropdown previews `GET /api/search`
  (session + in-conversation hits, terms marked), plus recent searches and saved
  filters. It degrades to a hint without Meilisearch and wraps to its own row below
  `sm`.
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
- **`TranscriptView`** (`components/TranscriptView.tsx`) — pages the transcript via
  `useInfiniteTranscript`, one disjoint `offset` block at a time
  (`userSettings.transcriptPageSize`, default 100), and switches between the two readers
  (**Timeline** / **Raw**; timeline is the default). Three things pull the next block:
  the **scroll sentinel** (600px lookahead, the same `useIntersectionObserver` the list
  uses), **background prefetch** while the tab is visible — so arriving at a session and
  immediately searching finds the text already loaded — and, once
  `userSettings.transcriptAutoLoadMax` (default 2 000) entries are in, a **"Load the
  remaining N entries"** button. That ceiling exists because nothing here is virtualised
  yet; past it, pulling the rest is the reader's explicit choice.

  This replaced a viewer that pinned `offset: 0` and grew `limit`. It read as
  incremental (`placeholderData` kept the old entries on screen) but re-fetched the whole
  prefix every time, so reaching entry 2 000 in blocks of 100 moved two hundred thousand
  entries over the wire. It also had a bespoke auto-load loop for search arrivals, which
  the background prefetch now subsumes.
  (Virtual scrolling is the planned follow-up; incremental paging keeps long
  transcripts responsive.)
- **`TranscriptTimeline`** (`components/TranscriptTimeline.tsx`) — the conversation
  reader. Dialogue turns sit on a vertical spine, labelled **You** / **Claude** with their clock time, the tools that turn called, a
  **subagent** chip for sidechain turns, and the text clamped to 14 lines with a
  "Show more". A pause of a minute or more between turns is drawn as "*12m later*".
  Everything that isn't dialogue collapses to one quiet line — `› 12 lines · Read ×3,
  Bash` plus an error count — which opens in place to the exact `TranscriptEntryRow`s
  the raw reader would have shown.
- **`TranscriptEntryRow`** (`components/TranscriptEntryRow.tsx`) — one raw line, used
  by the raw reader and inside an opened fold. An accordion: the summary shows its
  index, a kind chip (user / assistant / system / summary, color-coded), a
  **subagent** chip for sidechain entries, an **error** chip when the entry carries a
  tool error, and a one-line preview; the details pane shows the full text, or the
  raw entry as pretty-printed JSON when it has none.
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
- **`transcript-entry.ts`** — `summarizeEntry(entry)` → `EntryView` (`kind`,
  `preview`, `sidechain`, `isError`) over the webapi's pruned per-turn shape; defensive
  about turns with no text or an unknown role.
- **`transcript-timeline.ts`** — `buildTimeline(entries)` folds a page of entries
  into `TurnNode`s (dialogue) and `HiddenNode`s (a run of everything else), a lossless
  partition: every entry lands in exactly one node, in order. `isDialogue` is the
  judgement call it exists for — a user prompt or assistant prose only, so an
  assistant turn that is *just* tool calls, a slash-command echo, hook output and the
  local-command caveat all fold away. `<system-reminder>` blocks are stripped from
  displayed turn text (the raw reader still shows them). `summarizeHidden` writes a
  fold's one-line label; `nodeIndexContaining` finds the node a search match is in, so
  the fold hiding it opens on arrival.

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

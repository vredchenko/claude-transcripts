# webui — codebase reference

The **viewer**: a React single-page app for browsing session history. It is a
thin read client over the [webapi](webapi.md) — list, detail, and a transcript
viewer — and is deliberately minimal in Tier 1 (functional, lightly styled; a
visual rework is future scope, [#8](roadmap.md)). It stays **optional** —
everything it does is reachable via the CLI/API ([tiers.md](tiers.md)).

- **Package:** `packages/webui/` (workspace name `@claude-transcripts/webui`)
- **Stack:** React 19 + Vite 6 + MUI 6 (Emotion), TanStack Query 5, **TanStack
  Router**, TypeScript (ESM, strict). No separate state library — routing holds
  the navigational state and TanStack Query holds the server state.
- **Theme:** a restrained **light** baseline is the primary target (`theme.ts`);
  a dark variant is future scope. Shared style tokens (`LINK`, `CODE_BG`, `MONO`)
  are exported from `theme.ts`.
- **API client:** **generated** from the webapi OpenAPI spec into
  `src/api/generated.ts` (orval, `bun run gen:clients`;
  [ADR 0019](decisions/0019-openapi-source-of-truth-generated-clients.md), which
  supersedes the original [0006](decisions/0006-no-openapi-client-codegen-shared-types.md)
  "no codegen" stance) — not hand-written.
- **Build output:** `dist/` — served by the webapi under `/app` in production.

## What's built (Tier 1)

- Paginated **session list** (`/`) with per-column summary metrics — including
  **duration**, the working-directory **path** Claude was started from, and a
  **source** chip (live-recorded vs backfilled).
- **Session detail** (`/sessions/$id`) — metadata grid (with duration + recording
  source), token-usage breakdown, tool-call chips.
- A **transcript viewer** that pages entries incrementally; each entry previews
  on one line and expands to raw JSON.
- A header **Services menu** linking to the backing-service dashboards and the
  app's own API surface (placeholder URLs — see below).

## Still planned

- **Virtual scroll + configurable columns** for the long lists/transcripts —
  evaluate an existing npm dep (e.g. TanStack Virtual / `react-virtuoso`) rather
  than rolling our own; the transcript viewer already pages, this generalises it
  ([#8](roadmap.md)).
- **Config-driven Services menu.** The menu exists but its URLs are hard-coded to
  the bundled dev defaults; feeding them from the `/` app manifest's `servicesMenu`
  (so they follow a deployment's real ports/hosts) is [#14](roadmap.md).
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
└── src/
    ├── main.tsx               # React root: QueryClient + MUI theme + RouterProvider
    ├── router.tsx             # code-based TanStack Router tree (basepath "/app")
    ├── theme.ts               # dark MUI theme + shared MONO font stack
    ├── format.ts              # pure presentation helpers (no React)
    ├── transcript-entry.ts    # raw JSONL entry → compact EntryView
    ├── api/
    │   └── generated.ts       # orval snapshot: types + fetchers + query hooks
    ├── routes/
    │   ├── root.tsx           # RootLayout app shell (AppBar + Outlet)
    │   ├── sessions-list.tsx  # SessionsListPage — the "/" list
    │   └── session-detail.tsx # SessionDetailPage — "/sessions/$id"
    └── components/
        ├── ServicesMenu.tsx   # header dropdown of service/API links (placeholder)
        ├── TranscriptView.tsx # incrementally-paged transcript accordion
        ├── StatusChip.tsx     # session lifecycle chip (live / abandoned / ended)
        ├── SourceChip.tsx     # recording provenance chip (live / backfilled)
        ├── TokenUsageChips.tsx# token breakdown chips
        └── states.tsx         # Loading / ErrorState / EmptyState
```

## Bootstrap & routing

`src/main.tsx` mounts the app into `#root` under `StrictMode`: a
`QueryClientProvider` (30s `staleTime`, no refetch-on-focus, `retry: 1`), the MUI
`ThemeProvider` + `CssBaseline`, and a `RouterProvider`.

`src/router.tsx` builds a **code-based** TanStack Router tree (no file-based
plugin): a `RootLayout` root route with two children — `/` → `SessionsListPage`
and `/sessions/$id` → `SessionDetailPage`. The router is created with
`basepath: "/app"` because the SPA is served under `/app` in production
([ADR 0002](decisions/0002-single-combined-container.md)), matching Vite's
`base: "/app/"`. `RootLayout` (`routes/root.tsx`) is the shell: a sticky
transparent `AppBar` titled **Claude Transcripts** (linking home) over a
`Container` that renders the routed `<Outlet />`.

## API layer (`api/generated.ts`)

The generated snapshot is the single source of client types and data hooks. It
is overwritten by `bun run gen:clients` — **do not edit by hand**. Because the
webui is served same-origin under `/app` with `/api` proxied to the webapi, the
transport is a plain `fetch` against a `/api` base (no mutator, unlike the
off-origin CLI client). Non-2xx responses throw an `Error` carrying the status
line plus any `{ error }` detail from the JSON body.

It exports:

- **Types** inlined from the spec — `TokenUsage`, `SessionStatus`
  (`ended | running | incomplete`), `SessionSummary`, `SessionsResponse`,
  `TranscriptResponse`, and the param shapes.
- **Fetchers** — `listSessions`, `getSession`, `getSessionTranscript`.
- **Query keys** — `queryKeys.sessions/session/transcript`.
- **React Query hooks** (consumed by the views):
  - `useListSessions({ limit, skip })` → `GET /api/sessions` — the list.
  - `useGetSession(id)` → `GET /api/sessions/{id}` — detail (disabled until `id`).
  - `useGetSessionTranscript(id, { limit, offset })` →
    `GET /api/sessions/{id}/transcript` — paged for the viewer's "Load more".

All requests are relative (`/api/...`); in dev Vite proxies them to the webapi.

## Views

- **`SessionsListPage`** (`routes/sessions-list.tsx`) — fetches a page
  (`PAGE = 50`) and renders an MUI table: session id (first 8 chars, linked to
  detail), **started** time (session start), **duration**, **project** (trailing
  `cwd` segment), the full **path** Claude was started from (monospace, truncated,
  full on hover), model, a **source** chip (live / backfilled), prompt / event /
  tool counts, total tokens, transcript size, and a **status** chip. Paging is
  Previous/Next over a `skip` offset with a "N–M of total" label;
  `placeholderData: (prev) => prev` keeps the current page visible (dimmed) while
  the next loads. Every row links to its detail.
- **`SessionDetailPage`** (`routes/session-detail.tsx`) — reads `$id` from the
  route, fetches one summary, and renders a back link, the id + status chip, a
  metadata grid (started, **duration**, model, hostname, **recording** source,
  end reason, prompt / event / error counts, transcript size), the working
  directory, a **Token usage** row (`TokenUsageChips`), and a **Tool calls** chip
  set sorted by count. Mounts `TranscriptView` when `hasTranscript`, else shows a
  "no transcript was stored" note.
- **`ServicesMenu`** (`components/ServicesMenu.tsx`) — a header dropdown grouping
  quick links: this app's API reference (Scalar `/api/docs`), OpenAPI spec, and
  manifest (`/`); CouchDB Fauxton + a `_all_docs` JSON link; the Garage Web UI +
  bucket view; and the Meilisearch UI + API. The URLs are **placeholders** wired
  to the bundled dev ports — making them manifest-driven is [#14](roadmap.md).
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
  `YYYY-MM-DD HH:MM`), `formatDuration` (ms → `1h 2m` / `3m 4s` / `5s`, available
  for future duration columns), `projectName` (trailing `cwd` segment),
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
- Dev server defaults to `127.0.0.1:7651`, proxying `/api` →
  `http://127.0.0.1:7650` (`changeOrigin: true`).
- `bun run build` (root) outputs `packages/webui/dist/`, which the production
  image copies and the webapi serves via `CT_STATIC_DIR`
  ([ADR 0002](decisions/0002-single-combined-container.md)).

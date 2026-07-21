# webui — codebase reference

The **viewer**: a React single-page app for browsing session history. It is a
thin read client over the [webapi](webapi.md) — list, detail, and a transcript
viewer — and is deliberately minimal in Phase 1 (functional, lightly styled; a
visual rework is future scope, [#8](roadmap.md)).

- **Package:** `packages/webui/` (workspace name `@claude-transcripts/webui`)
- **Stack:** React 19 + Vite 6 + MUI 6 (Emotion), TanStack Query 5, Zustand 5,
  TypeScript (ESM, strict).
- **Build output:** `dist/` — served by the webapi in production.

## Tier-1 build plan

Start from the **current** webui (React 19 + Vite + MUI) and build forward — don't
rewrite. Planned additions:

- **TanStack Router** for real routing (replacing the hash-router placeholder in
  `store/useAppStore.ts`) + a **central state** store.
- **Generated API client** from the OpenAPI spec (orval), shared with the CLI
  ([ADR 0019](decisions/0019-openapi-source-of-truth-generated-clients.md),
  [dev-automation.md](dev-automation.md)) — replaces the hand-written `fetch`
  hooks.
- **Virtual scroll + lazy-loading** for the long lists/transcripts — evaluate an
  existing npm dep (e.g. TanStack Virtual / `react-virtuoso`) rather than rolling
  our own; the transcript viewer already pages, this generalises it ([#8](roadmap.md)).
- **Local-first browser caches** *(nice-to-have)* — persist TanStack Query cache
  (e.g. IndexedDB) so revisits are instant and partially offline.
- **Keyboard navigation** *(nice-to-have)* — list/detail/transcript navigable
  without the mouse.
- **Config-driven Services menu** fed by the `/` app manifest
  ([routes.md](routes.md), [#14](roadmap.md)) instead of hard-coded URLs.

The webui stays **optional** — everything it does is reachable via the CLI/API
([tiers.md](tiers.md)).

## File layout

```
packages/webui/
├── index.html                 # Vite HTML entry
├── vite.config.ts             # React plugin, dev server, /api proxy, dist output
└── src/
    ├── main.tsx               # React root bootstrap (#root, StrictMode)
    ├── App.tsx                # QueryClient + MUI theme + Header + Router
    ├── store/
    │   └── useAppStore.ts     # Zustand hash-router state
    ├── api/main/hooks/
    │   └── useClaudeSessions.ts  # fetch wrapper + TanStack Query hooks
    └── components/
        ├── ServicesMenu.tsx   # external-service links menu
        └── claude/
            ├── SessionList.tsx      # paginated sessions table
            ├── SessionDetail.tsx    # one session's metadata
            └── TranscriptViewer.tsx # lazy, paginated transcript
```

## Routing & state (`store/useAppStore.ts`)

Routing is **hash-based**, with no router library — a deliberate Phase-1
simplification. A small Zustand store holds `router.currentPath` (initialised
from `window.location.hash`, defaulting to `/claude`) and a `navigateTo(path)`
action that sets the hash. A global `hashchange` listener keeps the store in sync
with the address bar (so back/forward work). `App.tsx` matches the path: a
`/claude/session/<uuid>` path renders `SessionDetail`, anything else renders
`SessionList`.

## API layer (`api/main/hooks/useClaudeSessions.ts`)

A tiny typed client over the webapi — currently `fetch` + three TanStack Query
hooks consuming shared response types from `@claude-transcripts/shared`. **Direction:** this hand
-written client is slated to be replaced by a client **generated from the webapi
OpenAPI spec**, shared with the CLI ([ADR 0019](decisions/0019-openapi-source-of-truth-generated-clients.md),
which supersedes the original 0006 "no codegen" stance):

- `fetchJson<T>()` — wrapper that throws a typed `ApiError` (status + server
  details) on non-2xx.
- `useClaudeSessions(limit, skip)` → `GET /api/claude/sessions` — the list.
- `useClaudeSession(sessionId)` → `GET /api/claude/sessions/{id}` — detail.
- `useClaudeTranscript(sessionId, { enabled, limit, offset })` →
  `GET /api/claude/sessions/{id}/transcript` — **lazy** (`enabled` defaults
  false) and paged for the viewer's "Load more".

All requests are relative (`/api/...`); in dev Vite proxies them to the webapi.

## Views

- **`SessionList`** — fetches a page of sessions and renders an MUI table: date,
  status chip (green running / orange incomplete / grey ended), duration, project
  (last path segments of `cwd`), model (stripped of the `claude-` prefix), tokens
  (abbreviated), prompt / event / error counts, and top tools by count.
  `TablePagination` drives `limit`/`skip` (25/50/100). Clicking an **ended** row
  navigates to its detail.
- **`SessionDetail`** — fetches one summary and renders the metadata block (date,
  status, duration, `cwd`, hostname, model, counts), a **Token Usage** breakdown
  (total / input / output / cache write / cache read + message count) and a
  **Tool Usage** chip set, then mounts the `TranscriptViewer` when
  `session.hasTranscript`.
- **`TranscriptViewer`** — gated behind a "Load Transcript" button (the lazy
  query), then pages the transcript 100 messages at a time with "Load more".
  Each message renders as a role-tagged bubble; text blocks expand/collapse over
  ~500 chars; `tool_use` blocks render as separate expandable JSON panels. A 404
  is shown distinctly as "no transcript stored" vs. a real error.
- **`ServicesMenu`** — header dropdown linking to external dashboards
  (Swagger `/api/doc`, CouchDB Fauxton, Garage WebUI, Meilisearch). The URLs are
  currently hard-coded; making them config-driven from `claude-transcripts.config.json`
  `servicesMenu` is tracked in [#14](roadmap.md).

## Build & dev (`vite.config.ts`)

- Loads the **repo-root `.env`** (shared with the webapi) for `WEBUI_HOST/PORT`
  and the `WEBAPI_HOST/PORT` proxy target.
- Dev server defaults to `127.0.0.1:7651`, proxying `/api` →
  `http://127.0.0.1:7650` (`changeOrigin: true`).
- `bun run build` (root) outputs `packages/webui/dist/`, which the production
  image copies and the webapi serves via `CT_STATIC_DIR`
  ([ADR 0002](decisions/0002-single-combined-container.md)).

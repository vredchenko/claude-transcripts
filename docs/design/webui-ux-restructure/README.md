# Handoff: Claude Transcripts — WebUI UX restructure (v0.0.12)

## Overview

The current WebUI shows everything and prioritises nothing: 452 sessions land in a
14-column horizontally-scrolling table, six view modes compete via a nested toggle
matrix, search returns 104 pages of raw `tool_result` blobs, and the session detail page
buries the transcript under a 15-field metadata slab (half of whose fields read `—`).

This handoff restructures the UX without restyling it. **Every colour, font stack and
radius in the mock is already what `packages/webui/src/theme.ts` produces in light
mode.** The point is that a reviewer can diff structure without style noise. A separate
custom theme is a follow-up (see *Theming* below).

Six changes, in priority order:

1. Six view modes collapse to **two** — List and Calendar. Day grouping inside List
   absorbs the whole TIMELINE view; CARDS / COMPACT / TO SCALE disappear.
2. The search box becomes an **omnibox** that narrows the list in place. The dedicated
   results page becomes the exception, not the default.
3. The session row carries **more data in less space** — cwd, tool mix, and one
   active-vs-idle bar replacing three redundant duration columns.
4. Session detail defaults to **chat only**, with a per-turn gutter badge that expands
   just that turn's tool activity.
5. The Links menu gets **width, icons, hierarchy and permanent sublines**, and expands
   CouchDB into its real design views.
6. The Calendar becomes **proportional** — each day is a 24-hour lane, bars sit at their
   real hour and length, with metadata tooltips.

## About the design files

`Transcripts UX Redesign.dc.html` in this bundle is a **design reference written in
HTML** — a prototype of intended layout and behaviour, not production code to copy.

The target is the existing app: **React 18 + MUI + TanStack Router + TanStack Query +
Vite + Bun**, in `packages/webui/`. Recreate the designs using that stack and its
established patterns:

- **Do not** port the mock's inline styles. The mock uses literal hex values because it
  must render standalone; the real app must keep reading semantic MUI tokens
  (`primary.main`, `divider`, `text.secondary`, `background.paper`) so both colour modes
  and the forthcoming custom theme keep working. Where the mock says `#0969da`, write
  `primary.main`. Where it says `#57606a`, write `text.secondary`. The mapping table in
  *Design tokens* below is exhaustive.
- **Do not** hand-roll components MUI already provides. The mock draws its own dropdowns
  and toggle groups; use `Menu` / `ToggleButtonGroup` / `Autocomplete` as the existing
  code does.
- The mock is a single flat canvas showing six screens side by side. That is a review
  artefact. The real implementation keeps the current route structure.

## Fidelity

**High-fidelity on structure, layout and behaviour. Not a pixel target on chrome.**

Layout, information hierarchy, column order, spacing rhythm, copy, empty states and
interaction model are all decided and should be implemented as specified — the pixel
measurements in this document are real and worth honouring.

The visual styling is deliberately *the current theme*, so there is nothing new to match
there: keep using `createAppTheme()`. Anywhere the mock and MUI's defaults disagree
cosmetically (exact shadow, exact chip radius), **MUI wins** — that divergence is noise
from the mock being framework-free, not a design decision.

---

## Screens / views

### 01 — Session list (`/`)

Replaces `routes/sessions-list.tsx` plus `components/sessions/SessionsTable.tsx` and
`SessionsTimeline.tsx` (the latter is deleted).

**Purpose.** The triage surface. A user arrives knowing roughly what they want ("that
long jobhunt session last week that errored") and must reach it in one or two actions
without knowing a session id.

**Layout.** Full-width, three stacked bars over a scrolling body.

- **Header bar** — 10px vertical / 15px horizontal padding, `background.paper`, 1px
  bottom divider. Three zones: brand left (logo mark 22×22, product name 15px/650,
  version 11px mono `text.disabled`), omnibox centred with `max-width: 660px`, actions
  right (settings gear 29×29, Links button).
- **Toolbar** — same padding and divider. `Sessions` at 19px/650, then a count pill
  (12px mono, `background.default` fill, 11px radius, 2px/7px padding) reading
  `3 of 452 shown` when filtered and `452 sessions` when not. Active filter chips
  follow at 12px left margin. View toggle right-aligned.
- **Column header** — `background.default`, 8px/15px padding, 10.5px/700 labels with
  `0.06em` letter-spacing, `text.secondary`.
- **Body** — day-group headers interleaved with rows.

**Grid.** One `grid-template-columns` shared by the column header and every row, so they
cannot drift:

```
60px  1fr   150px  118px  128px  104px  84px  30px
time  proj  runtime host   tools  tokens status copy
```
with `gap: 12px` and `padding: 8px 15px` per row.

**Columns.**

| Column | Content | Type |
| --- | --- | --- |
| TIME | `02:27` — start time only; the date lives in the group header | 12.5px mono, `text.secondary` |
| PROJECT · WORKING DIR | Two lines. Line 1: project name, 13.5px/550, `primary.main`, ellipsised, followed by an error badge when `error_count > 0`. Line 2: cwd 11px mono `text.secondary` ellipsised, a `·` separator, then the 8-char session id 10.5px mono `text.disabled` | sortable |
| RUNTIME · ACTIVE | Line 1: `24m 45s · 14m active` at 12.5px. Line 2: a 4px-tall bar, 2px radius, `rgba(0,0,0,0.07)` track, `primary.main` fill at `active/runtime × 100%` | sortable |
| HOST · MODEL | Host 12px ellipsised; model 10.5px mono `text.disabled`, stripped of the `claude-` prefix (`opus-5[1m]`, not `claude-opus-5[1m]`) | |
| TOOL MIX | Up to two `Tool N` pills plus a `+N` overflow pill, ordered by count desc. 10px mono, `background.default` fill, 1px divider border, 3px radius | |
| TOKENS · TURNS | Right-aligned. Tokens 12px mono; event count 10.5px mono `text.disabled` below | sortable |
| STATUS | One chip, centred — reuse `components/StatusChip.tsx` | |
| — | Copy-session-id icon button, 24×24, `text.disabled` → `text.primary` on hover | |

**Day group header.** `background.default`, `padding: 9px 15px 7px`, 1px bottom divider.
`Thu 27 Aug` at 12px/700, then `2026 · 7 sessions` at 11.5px `text.disabled`, then a
1px rule filling remaining width, then right-aligned rollup `3h 12m active · 8.1M tokens`
at 11px mono `text.disabled`. **The rollup is new data** — sum active-time and tokens per
day. It is the single highest-value addition on this screen: it answers "was that a heavy
day" without opening anything.

**Error badge.** `1 error` / `4 errors`, 10.5px/600, `error.main` on
`rgba(207,34,46,0.08)`, 3px radius, 1px/5px padding. Only rendered when non-zero.

**Row states.** Hover → `background.default`. Whole row is the link to
`/sessions/$id`; the copy button must `stopPropagation`.

**What is removed.** The pager (`PREVIOUS / 1–50 / NEXT`) is replaced by infinite scroll
— see *Interactions*. The Idle column is gone (it is `runtime − active`, and the bar now
conveys the ratio). The Prompts, Events, Tools and Tokens columns collapse into two.
The `Source` column's `live` chip merges into STATUS.

---

### 02 — Omnibox

Replaces `components/SearchBox.tsx`. This is the largest behavioural change in the
handoff and should probably be its own PR.

**Purpose.** One field for every way a user refers to a session: filter it, full-text it,
jump to it by id, or run a command. Today the box does one thing — full-text search that
navigates away — which is why it reads as unusable.

**Layout.** 34px tall, `max-width: 660px`, 7px radius, 1px divider border,
`background.default` fill when idle. On focus: 1.5px `primary.main` border plus a
`0 0 0 3px rgba(9,105,218,0.10)` focus ring, fill goes to `background.paper`. Input is
12.5px **mono** — queries are structured text, not prose. A `⌘K` hint pill sits at the
right edge, 11px mono, 1px divider border, 4px radius.

Placeholder: `Filter, search, or run a command — project:jobhunt errors:>0`

**Dropdown.** Absolutely positioned 42px below the field, matching width, 8px radius,
`0 16px 40px rgba(31,35,40,0.18)` shadow, 6px padding. Section headings are
10px/700/`0.07em` `text.disabled`, 8px/8px/4px padding. Items are 6px/8px, 5px radius,
`background.default` on hover, `rgba(9,105,218,0.07)` when selected. Each item is
icon (12.5px, 15px-wide centred column) + label (12.5px) + optional mono subline
(10.5px `text.disabled`) + optional right-aligned keycap.

**Four input modes.** The mock shows three panels (A/B/C) demonstrating them:

1. **Plain text** → two offers, always in this order:
   - `Narrow the session list` — `↵` — matches against project, host, cwd and id.
     Subline: `matches project, host, cwd, id`.
   - `Search inside transcripts` — `⇧↵` — subline shows the live count from the search
     index, e.g. `12 sessions · 47 turns`.
   Below them, an `OPERATORS` section as inline documentation so operators are
   discovered rather than memorised.
2. **Operators** — parsed as `key:value`, ANDed together:
   - `project:` (maps to the API's `cwd`), `host:` (`hostname`), `model:`, `source:` —
     exact match, autocompleted from the current corpus.
   - `errors:>0`, `tokens:>1M`, `runtime:>1h`, `active:<10%` — numeric comparison,
     operators `>` `<` `>=` `<=` `=`, with `k`/`M` and `s`/`m`/`h` suffixes.
   - A bare token with no colon is free text.
3. **Relative dates** — `last week`, `yesterday`, `aug 19`, `this month` resolve to a
   range and echo the resolution back before the user commits:
   `20 – 27 Aug 2026`, subline `started:2026-08-20..2026-08-27`.
4. **Id prefix** — 4+ hex chars offers a direct jump, with the full uuid as the label
   and `jcousteau · 27 Aug 00:54 · ended` as the subline so the user can confirm before
   navigating.

Plus two persistent sections:

- **Saved filters** (`★`) — named queries, e.g. `Long idle sessions` /
  `active:<10% runtime:>1h`, `Failed tool runs` / `errors:>0 last week`.
- **Recent searches** (`↺`) — last 5, with a relative timestamp subline.

**Commands.** A leading `>` switches to command mode: `> theme dark`,
`> couch doc` (open the current session's CouchDB document), `> export csv`,
`> open meilisearch`. Command targets come from `/api/model`'s `servicesMenu` — never
hardcode ports, for the reason documented in `LinksMenu.tsx`.

**Keys.** `⌘K` / `Ctrl+K` focuses and selects all. `↵` applies the highlighted offer.
`⇧↵` forces full-text. `↑`/`↓` move. `Esc` closes the dropdown, second `Esc` clears the
query. `⌫` on an empty query removes the last filter chip.

**Filter chips.** Applying a filter converts it to a chip in the toolbar: 26px tall,
13px radius, `rgba(9,105,218,0.35)` border, `rgba(9,105,218,0.07)` fill, 11.5px mono
`primary.main` label, and a 17px circular `×`. A dashed `+ Filter` chip opens the same
dropdown scoped to operators. **Chips are URL state** — extend `SearchRouteSearch` in
`search-query.ts` — so a filtered list is shareable and survives reload.

---

### 03 — Links menu

Replaces `components/LinksMenu.tsx`. Currently 4 flat groups of bare labels in a
default-width MUI `Menu`.

**Purpose.** The operator's jump-off point to every backing service. It fails today
because a label like `CouchDB · Fauxton` says nothing about what you will find there,
and there is no path to the design views that actually answer questions.

**Layout.** **360px wide** (up from MUI's default ~180px), 9px radius,
`0 20px 48px rgba(31,35,40,0.22)` shadow, 6px padding, anchored 47px below the header,
13px from the right edge.

**Group heading.** 10px/700/`0.07em` `text.disabled`, `padding: 9px 10px 5px`, followed
by a 1px rule filling the remaining width.

**Item.** `display: flex`, 9px gap, `padding: 5px 10px`, 6px radius,
`background.default` on hover. Three parts:
- **Icon**, 12.5px, in a 16px-wide centred column, `text.secondary`.
- **Label** 12.5px `text.primary`, with a 9.5px `↗` after it when the link leaves the app.
- **Subline** 10px mono `text.disabled`, ellipsised — a permanent tooltip. This is the
  key change: the information a tooltip would have hidden behind hover is always visible.
- **Indent** — second-level items get `margin-left: 16px`.

**Contents.** Four groups. Second level under CouchDB is new and is generated, not
written by hand:

```
THIS APP
  ▤  Technical docs              /docs
  ◈  API reference (Scalar)      /api/docs
  { } OpenAPI spec               /api/openapi.json
  { } App model                  /api/model — resolved ports & services
  ⇩  Download CLI binary         /cli/download

COUCHDB
  ⛁  Fauxton                     :7652/_utils — database admin UI
    ◱ _design/sessions           by_date · by_cwd
    ◱ _design/chunks             by_session · entries_by_session
    ◱ _design/events             by_session · by_type
    ◱ _design/tools              usage · failures · errors
    ◱ _design/activity           timeline — events per hour
    ◱ _design/session_meta       start_meta · tokens_by_date

SERVICES
  ▦  Garage · Web UI             object storage for raw transcripts
  ⌕  Meilisearch · UI            index browser
  ⌕  Meilisearch · API           /indexes — health & stats

PROJECT
  ◇  GitHub repository           vredchenko/claude-transcripts
  ◇  Docs source (Markdown)      /tree/main/docs
```

**The design-view links must be generated from `INITIAL_DESIGNS`.** `designs.ts` already
exports the authoritative definitions; `Object.keys(design.views)` gives the subline and
`design._id` gives the label and the Fauxton URL. Do this either by importing the array
directly from `@claude-transcripts/shared` at build time, or by exposing it on
`/api/model` alongside `servicesMenu` at API start. Do not maintain a second hardcoded
list — it will drift the first time a migration adds a view, which is exactly the bug
`LinksMenu.tsx`'s own comment describes for ports.

Fauxton design-view URL shape:
`{couchUrl}/_utils/#/database/{db}/_design/{name}/_view/{view}`.

The existing rule stands: a group whose links cannot be resolved from `/api/model` is
**omitted entirely** rather than falling back to defaults.

---

### 04 — Calendar (`/?view=calendar`)

Replaces `components/sessions/SessionsCalendar.tsx`.

**Purpose.** Answer "when do I actually work, and what did a given stretch of time go
on". The current month grid cannot: it draws one equal-height bar per session per day
with no time axis, so a 1-second session and a 6-hour session look identical, and the
per-project pastel is unlabelled.

**Layout.** A **24-hour lane per day**, stacked vertically — a day-rows-by-hours grid
rather than a month calendar.

- **Axis header.** `grid-template-columns: 116px 1fr`. The right cell is
  `repeat(24, 1fr)` of 9.5px mono `text.disabled` hour labels, rendered on even hours
  only (`00`, `02`, … `22`) to avoid crowding. 4px vertical padding,
  `background.default`, 1px bottom divider.
- **Day row.** Same 116px/1fr split, `min-height: 52px`, 1px bottom divider.
  - Left cell: 9px/12px padding, 1px right divider. Day label `Thu 27` 12.5px/600, then
    `7 sessions · 3h 12m` at 10.5px `text.disabled`.
  - Right cell: `position: relative`, with hour gridlines drawn as
    `repeating-linear-gradient(to right, rgba(0,0,0,0.05) 0 1px, transparent 1px calc(100% / 24))`.
    One CSS declaration, no 24 DOM nodes per row.

**Session bar.** Absolutely positioned, 15px tall, 3px radius, 1px border, 0/5px padding,
label 9.5px ellipsised.
- `left = start_hour_fraction / 24 × 100%`
- `width = runtime_hours / 24 × 100%`, floored at ~0.4% so a 1-second session stays
  clickable
- `top` = 6px, 24px, 42px … by lane assignment (see below)
- **Opacity encodes activity ratio**: `rgba(primary, 0.20 + 0.35 × active/runtime)`, so a
  mostly-idle session reads pale and a busy one reads solid. Abandoned sessions use the
  warning hue instead of primary.

**Overlap.** Bars are packed into sub-lanes greedily by start time; a row grows in 18px
increments per occupied lane. A session crossing midnight is clipped to each day it
touches and gets a subtle edge marker; the label shows the total (`37h 1m (spans days)`).

**Tooltip.** The feature this screen exists for. 262px wide, `text.primary` (`#1f2328`)
background, 7px radius, 9px/11px padding, `0 12px 30px rgba(0,0,0,0.28)` shadow.
Title = project, 12px/600 white. Subline = `e94ffb25 · /srv/claude-transcripts`, 10px
mono at 55% white. 1px 14%-white rule. Then key/value rows, 10.5px, key at 55% white and
value in white mono, `justify-content: space-between`:

```
started            26 Aug 20:41
runtime            5h 58m
active             1h 14m (21%)
model              opus-5[1m]
prompts · tools    8 · 132
status             live
```

Positioned at the bar's `left`, `top: 30px`, flipping above when within 170px of the
container's bottom edge and clamping horizontally to stay in view. The hovered bar gets
`0 0 0 3px rgba(9,105,218,0.22)` and a solid `primary.main` border so the tooltip visibly
belongs to it.

**Legend** in the header: `active` (solid primary) and `idle` (22% primary) swatches,
22×8px, 2px radius.

**Retain** the existing month/day navigation (`‹ ›`, `TODAY`) and the click-through to a
single day. The current *day* view (screenshot 15) is closer to right than the month view
— its problem is only that it is 90% empty whitespace; this design's per-day lane is the
compact form of the same idea.

---

### 05 — Session detail (`/sessions/$id`)

Replaces `routes/session-detail.tsx`, `components/TranscriptView.tsx`,
`TranscriptTimeline.tsx` and `SpeakerTurnsView.tsx`.

**Purpose.** Read the conversation. Today the conversation is the last thing on the page
and frequently absent.

**Layout.** Four stacked bars, then the turn stream.

**1. Identity bar.** `background.paper`, 11px/15px padding, 1px bottom divider.
`← All sessions` (12.5px `primary.main`), 1px 16px vertical rule, project name
15px/600 `primary.main`, 8-char id 12px mono, a 22×22 copy-full-uuid button, status chip.
Right-aligned, three deep-link buttons — 27px tall, 9px padding, 6px radius, 1px divider
border, 11.5px, `primary.main` border and text on hover, each with a leading icon and a
trailing 9px `↗`:

| Button | Target | `title` |
| --- | --- | --- |
| `⛁ CouchDB doc` | `{couchUrl}/_utils/#/database/{db}/{session_id}` | Open the summary document in Fauxton |
| `▦ Garage object` | the raw transcript object | Open the raw transcript object in Garage |
| `{ } API JSON` | `/api/sessions/{id}` | /api/sessions/7aa60fae… |

These three are a direct request and are cheap: two are string-built from the session id
and the resolved service URLs in `/api/model`. **Open question — the Garage object key:**
if it is derivable client-side from the session id, build it; if not, the session summary
response needs to carry it.

**2. Metadata strip.** The 15-field slab becomes **one horizontal scrolling strip**.
Each field is a 9.5px/700/`0.06em` `text.disabled` label over a 12px mono value, with
16px right padding and a 1px right divider. Order:
`STARTED · RUNTIME · ACTIVE · MODEL · HOST · TOKENS · PROMPTS · TOOLS · ERRORS · SIZE`.
A right-aligned `cwd, end reason, cache split ▾` link expands the remainder.
**Fields whose value is `—` are omitted entirely, not rendered empty** — that alone
removes most of the current slab on a typical session.

**3. Transcript toolbar.** `Transcript` 16px/650, then
`6 turns · chat only · 194 tool lines hidden` at 11.5px `text.disabled` — the subline
states what is being hidden, so chat-only never feels like data loss. Right side:
- A **Tool activity** switch (24×14px track, 10px knob) — global expand/collapse.
- A `BOTH / YOU / CLAUDE` `ToggleButtonGroup`, replacing today's `FULL / YOU / CLAUDE`.
- The `TIMELINE / RAW` toggle moves into an overflow menu; raw JSON is a debugging
  affordance, not a peer of the reading view.

**4. Turn stream.** Per turn, `grid-template-columns: 96px 1fr 84px`, 10px gap,
7px/15px padding, `#fafbfc` on hover.

- **Left gutter (96px), right-aligned.** Absolute clock `00:54:12` at 11.5px mono
  `text.secondary`, and **relative offset from session start** `+7m 53s` at 10px mono
  `text.disabled` below it. Timestamps on every line are a direct request; the relative
  offset is the addition that makes a long session legible.
- **Centre.** A name row — speaker 12px/650 (`primary.main` for You, `text.primary` for
  Claude) — then, when the turn has tool calls, the **gutter badge**: a pill reading
  `142 tool calls · 24 Bash`, 10px mono, `background.default` fill, 1px divider border,
  10px radius, 1px/7px padding, `primary.main` on hover. Clicking expands *only that
  turn*. Then the message body: 13px/1.55, `text-wrap: pretty`, 8px/11px padding, 6px
  radius, and a **3px left accent border** — `primary.main` + `background.default` fill
  for You, `#D97757` (the brand mark's colour) + `background.paper` for Claude. Long
  bodies clamp with a `SHOW MORE` affordance, as today.
- **Right (84px).** Turn index `#152` in 10px mono, a copy-turn-as-markdown button, and
  a `#` permalink button. Both 22×22, `text.disabled` → `text.primary` on hover.
- **Time gaps.** Between turns more than ~2 minutes apart, a centred rule with
  `5m 53s later` at 10.5px italic `text.disabled` — keep the existing behaviour, it works.

**Expanded tool panel.** Directly under the body, 6px top margin, 1px divider border,
6px radius. Rows of `grid-template-columns: 74px 84px 1fr 26px`:
timestamp (10.5px mono `text.disabled`), tool-name pill (10.5px mono on
`background.paper`, 1px border, 3px radius, centred), single-line input preview (10.5px
mono `text.secondary`, ellipsised), copy button. A user turn can never render this panel.

**What is removed.** The `LOAD MORE` button and the `› 90 lines Bash ×15 · attachment:…`
interstitials. Those interstitials are the current design's answer to hiding tool noise,
and the per-turn badge replaces them: noise attaches to the turn that caused it rather
than sitting between turns as an unattributed block.

---

### 06 — Search results and empty states

**Search results** (`routes/search-results.tsx`) — grouped by session, not a flat turn
dump. Reached only via `⇧↵`.

- **Header.** `Results for` + the query in a 13px mono pill, then honest totals
  `12 sessions · 47 turns`, then a right-aligned `↩ narrow the list instead` escape back
  to the omnibox. **Fix the count bug** — the current page renders `about 0 sessions ·
  2073 turns`; a zero session count beside 2073 turn hits is self-evidently wrong and
  destroys trust in the whole page.
- **Session group header.** `background.default`, 9px/15px. Project 13px/600
  `primary.main`, id 10.5px mono, date 11px, right-aligned hit-count pill `18 hits`.
- **Turn hit.** `grid-template-columns: 74px 1fr`, 7px/15px, 1px top divider. Left:
  timestamp 10.5px mono and role `YOU` / `CLAUDE` / `TOOL` at 9.5px/600
  `text.disabled`. Right: an 11px mono snippet, `line-height: 1.5`, with the match
  wrapped in `highlightBg(mode)` — reuse `components/HighlightedText.tsx` and
  `shared/src/highlight.ts` unchanged.
- **Keep** the existing `cwd / model / hostname / source` filter row; it is fine.
- The existing 20-per-page pager can stay here — this page is a deliberate destination,
  not the landing view.

**Empty state — speaker split.** The current message is
`No turns to show. Speaker-split needs full-content chunks — sessions logged with
couchFullContentChunks off have none.` That names an internal flag and offers no action.
Replace with:

> **No chat turns were recorded for this session**
> The hook stored byte ranges only, so there is nothing to split by speaker. The raw
> transcript is still available in object storage.
> `[Open raw transcript]` `[How to enable full capture ↗]`

Primary button `primary.main` filled, secondary outlined, both 30px tall / 6px radius,
linking to the Garage object and to the relevant `docs/` page. Apply the same pattern to
`No transcript was stored for this session.` — every empty state names the remedy, never
the flag.

---

## Interactions & behaviour

**Infinite scroll (list and transcript).** Both use `useInfiniteQuery` with an
`IntersectionObserver` sentinel at the end of the list, root margin ~600px so the fetch
starts before the user reaches the bottom. The loading row is a 12px spinner
(2px border, `primary.main` top) plus 12px `text.disabled` text —
`loading more as you scroll`, and `loading turns as you scroll · 4 of 6` where a total is
known. Page size: 50 for sessions, 40 turns for transcripts. **Both replace pagers**;
keep the offset/limit maths from `search-query.ts` for the search page.

Because the sessions list is long-lived and virtualisable, consider
`@tanstack/react-virtual` for the row body — 452 rows is fine unrendered, but the corpus
grows.

**Sorting.** Click a sortable column header to sort; click again to reverse. The indicator
is `⇅` when inactive and `↓`/`↑` when active, `text.disabled`, in the header. Sort state
is URL state. Default `started desc`. Sorting a day-grouped list sorts *within* groups
when the sort key is not time, and collapses grouping when it is anything else — decide
this explicitly and note it; the simplest correct behaviour is *sorting by a non-time
column drops day grouping*.

**Omnibox debounce.** 150ms on live narrowing, so typing `project:jobhunt` does not fire
nine requests. Id-prefix and operator parsing are synchronous and local.

**Theme switching.** Unchanged mechanism — `color-mode.tsx` and the settings menu.

**Transitions.** Nothing new. Tool-panel expansion uses MUI's default collapse timing;
hovers are instantaneous. This design needs no animation work.

**Responsive.** The list grid needs a breakpoint below ~1100px: drop TOOL MIX first, then
HOST · MODEL, then collapse RUNTIME · ACTIVE to the bar alone. TIME, PROJECT, TOKENS and
STATUS always survive. The calendar's 24h lane holds up to about 700px, below which it
should fall back to the existing day view.

---

## State management

**URL state** (extend `SearchRouteSearch` in `search-query.ts`; TanStack Router owns it):

```ts
{
  q?: string            // omnibox raw text
  view?: 'list' | 'calendar'
  sort?: 'started' | 'project' | 'runtime' | 'tokens'
  dir?: 'asc' | 'desc'
  // filter chips, parsed from operators
  cwd?: string; model?: string; hostname?: string; source?: string
  errors?: string       // comparison expr, e.g. '>0'
  tokens?: string; runtime?: string; active?: string
  from?: string; to?: string   // resolved date range, ISO
  page?: number         // search results only
  month?: string        // calendar
}
```

**Component state.** Omnibox: `open`, `highlightedIndex`, `mode` (filter | fulltext |
jump | command). Session detail: `expandedTurns: Set<string>`, `showAllTools: boolean`,
`speaker: 'both' | 'you' | 'claude'`, `metaExpanded: boolean`. Calendar: `hoveredBarId`.

**Persisted locally.** Recent searches (last 5) and saved filters — `localStorage` is
acceptable for v1; server-side persistence is an open question below.

**Data.** All reads go through the generated client in `src/api/generated.ts`; regenerate
via `orval` if the API changes. Known API gaps this design implies:

1. **Per-day rollups** — active-time and token sums per day for the group headers.
   `_design/session_meta/tokens_by_date` already reduces tokens by `[y,m,d]`; active time
   needs an equivalent. Do it server-side; do not sum client-side over a paged list, which
   would give wrong totals for any day not fully loaded.
2. **Tool mix per session** — top-N tool names with counts on the session summary.
   `_design/tools/usage` has the data but keyed by tool, not by session.
3. **Active-time percentage** — either returned directly or derived from
   `runtime − idle`; confirm which is authoritative.
4. **Numeric filter operators** — `errors:>0`, `tokens:>1M` etc. need query support on
   the sessions endpoint.
5. **Garage object key** per session (see above).
6. **Stable per-turn anchor** for `#` permalinks — likely `byte_start` from
   `_design/chunks/entries_by_session`, whose key is already
   `[session_id, byte_start, entry_index]`.

---

## Theming

**Light stays the default and is unchanged.** Do not touch the light palette in
`createAppTheme()` as part of this work.

The dark palette also stays as-is. A **third, custom theme** is coming and its palette
will be specified separately by the project owner. Prepare for it structurally now, so
adding it later is data and not a refactor:

- `ColorMode` in `theme.ts` becomes a named union — `'light' | 'dark' | '<custom>'` —
  rather than a boolean-ish pair. Note that `createAppTheme()` currently branches on
  `const dark = mode === "dark"`, and `codeBg()`, `highlightBg()` and `highlightFg()`
  each re-derive from the mode with their own two-branch conditional. Replace all four
  with a single palette record keyed by mode, so a third entry is one object literal.
- `color-mode.tsx` and the settings menu's `Light / Dark / Follow system` list must
  become an n-way list. `Follow system` maps to light or dark only.
- Every component must read semantic tokens. Any literal hex outside `theme.ts` is a bug
  that will surface as an unreadable element in the third theme — this is the main reason
  not to port the mock's inline hex values.

---

## Design tokens

Sourced from `packages/webui/src/theme.ts` (light mode). **Use the token, not the hex.**

| Mock hex | MUI token | Used for |
| --- | --- | --- |
| `#f6f8fa` | `background.default` | page background, header fills, hover states |
| `#ffffff` | `background.paper` | cards, rows, dropdowns |
| `#0969da` | `primary.main` | links, project names, active bar, focus ring |
| `#1f2328` | `text.primary` | body text, tooltip background |
| `#57606a` | `text.secondary` | labels, sublines, mono metadata |
| `#8b949e` | `text.disabled` | headings, hints, ids, timestamps |
| `rgba(0,0,0,0.10)` | `divider` | bar dividers, borders |
| `rgba(0,0,0,0.06–0.08)` | — | row dividers (use `divider` at lower alpha) |
| `#cf222e` | `error.main` | error badges |
| `#1a7f37` | `success.main` | `live` status |
| `#9a6700` | `warning.main` | `abandoned` status |
| `#fff3c4` | `highlightBg('light')` | search match background |
| `#D97757` | brand mark | logo, Claude turn accent |

**Type.** Body/UI: `-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica,
Arial, sans-serif` (`FONT_STACK`). Mono: the exported `MONO` constant. Mono is used for
**all** ids, paths, timestamps, token counts, model names, and omnibox input — anything
the user might compare character by character.

Sizes in use: 9.5, 10, 10.5, 11, 11.5, 12, 12.5, 13, 13.5, 15, 16, 19px.
Weights: 550 (row emphasis), 600, 650 (headings), 700 (micro-labels).
Micro-labels (`TIME`, `STARTED`) are 9.5–10.5px/700 with `0.06–0.07em` letter-spacing,
uppercase.

**Spacing.** 4 / 5 / 6 / 7 / 8 / 9 / 10 / 12 / 15 / 16 / 20 / 26px. Row padding
`8px 15px`; bar padding `10–11px 15px`; dropdown item padding `5–6px 10px`.

**Radius.** 3px (micro pills) · 4px (keycaps) · 5px (dropdown items, icon buttons) ·
6px (buttons, bodies, panels) · 7px (input, tooltip) · 8–9px (cards, dropdowns) ·
10–13px (chips, status pills) · 50% (circular).

**Shadows.** Card `0 10px 30px rgba(31,35,40,0.09)` · dropdown
`0 16px 40px rgba(31,35,40,0.18)` · menu `0 20px 48px rgba(31,35,40,0.22)` · tooltip
`0 12px 30px rgba(0,0,0,0.28)` · focus ring `0 0 0 3px rgba(9,105,218,0.10)`.
In MUI terms these are roughly `elevation` 2 / 8 / 16 — prefer the elevation.

---

## Assets

**Logo mark** — `brand/logo-mark.svg` from the repo, unchanged: a 32×32 `#D97757`
rounded square (`rx=7`) with three white rounded bars at 96% / 74% / 96% opacity. Already
present at `packages/webui/src/assets/logo-mark.svg`; keep using that import. Rendered at
22×22 in the header.

**Icons.** The mock uses Unicode glyphs (`⛁ ▦ ⌕ ◱ ◈ ⇩ ★ ↺ ⧉ ↗`) as placeholders so it
could render with no dependencies. **Do not ship those.** Substitute the icon set the app
already uses (`@mui/icons-material`), mapping by meaning:

| Mock glyph | Meaning | MUI suggestion |
| --- | --- | --- |
| `⧉` | copy | `ContentCopy` |
| `⌕` | search | `Search` |
| `⛁` | database | `Storage` |
| `▦` | object storage | `Inventory2` / `Cloud` |
| `◱` | design view | `TableChart` |
| `◈` | API reference | `Api` |
| `{ }` | JSON | `DataObject` |
| `⇩` | download | `Download` |
| `★` | saved filter | `StarBorder` |
| `↺` | recent | `History` |
| `↗` | external link | `OpenInNew` |
| `▤` | docs | `MenuBook` |
| `#` | permalink | `Tag` / `Link` |

A wider combined logo lockup is being designed separately and is **not** part of this
handoff.

---

## Files

| File | What it is |
| --- | --- |
| `Transcripts UX Redesign.dc.html` | The design reference. Six screens on one canvas, top to bottom: 01 session list, 02 omnibox (three states), 03 links menu, 04 calendar, 05 session detail, 06 search + empty states. Open in a browser; it is self-contained apart from its sibling `support.js`. |
| `support.js` | Runtime for the design file. Not part of the implementation. |
| `logo-mark.svg` | The brand mark, copied from `brand/` in the repo. |
| `github.md` | Records which repo files each screen was derived from. |

Screenshots of the current production UI (23 states, light and dark) exist in the design
project and can be supplied on request — they are the *before*, not the target.

---

## Suggested order of work

1. **Session list row + day grouping + sorting.** Highest value, no API changes beyond
   the day rollups. Delete `SessionsTimeline.tsx`.
2. **Links menu.** Self-contained, one file, immediately useful, and forces the
   `designs.ts` → menu generation that removes a whole class of drift.
3. **Session detail: chat-only default + timestamps + copy + deep links.** No new
   endpoints except the Garage key.
4. **Omnibox.** The biggest piece; depends on numeric filter support in the API. Ship
   filter-narrowing and id-jump first, then commands and saved filters.
5. **Calendar.** Self-contained rewrite of one component.
6. **Search results regrouping + count fix + empty states.**
7. **Theme structure prep**, then the custom theme when its palette arrives.

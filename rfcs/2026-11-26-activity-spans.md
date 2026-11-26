# Activity spans: when a session was worked on, not just how long it was open

**Date:** 2026-11-26
**Status:** Proposed.

## The problem

A calendar bar runs from a session's first event to its last. That is how long the
session was *open*, which can be very different from when it was *worked on*. A session
left in a terminal over a weekend, with four turns on Friday and two on Monday, is drawn
as a solid three-day block. Opacity hints at the active share, but not where in the bar
the work happened, and on a calendar *when* is the whole point.

The list has the same blind spot in a smaller form: its active/idle bar is a proportion
(`activeMs / durationMs`), with no idea of position.

## What we already have

Less is missing than it looks. `activeMs` is not stored. The webapi derives it on every
read, in [`storage/active-duration.ts`](../packages/webapi/src/storage/active-duration.ts):

1. For each session on the page, it reads every event's timestamp from the
   `session_index/event_times` view (migration v9). A list page is 50 sessions, and a
   calendar month up to 500, in batches of 100 keys.
2. `sumActiveDurationMs` sorts them and adds up every gap between consecutive events
   that is no longer than `system.sessions.idleThresholdMs` (5 minutes by default).
3. The result is memoised per `(sessionId, newest timestamp, threshold)`. Docs are
   append-only, so an ended session's answer is final; a live one recomputes when new
   events land.

The spans we want are a by-product of step 2. A run of events whose gaps are all within
the threshold is one active span. A gap over the threshold ends it. `activeMs` is the sum
of the span lengths, so it comes out of the same computation exactly.

So this needs **no new reads, no new view, no migration and no change to any stored
document**. It is a read-side projection of data the webapi already fetches for every
session it lists.

## Proposal

### 1. Compute spans where `activeMs` is computed

Add `activeSpans(timestamps, idleMs)` to `@claude-transcripts/shared`, next to
`sumActiveDurationMs`. It is pure and isomorphic, so it can be tested in isolation. It
returns merged `[start, end]` intervals. A lone event after a long gap is a span of zero
length, a point. It matters ("came back, asked one thing, left"), and the UI draws it at
a minimum width.

`sumActiveDurationMs` becomes the sum over `activeSpans`, so there is one definition of
"active", and a test asserts the two agree on random input.

`active-duration.ts` memoises the spans instead of the number, and derives `activeMs`
from them. The cache key is unchanged, and so is its invalidation reasoning.

### 2. Serve them on `SessionSummary`

Add one optional field to the OpenAPI contract:

```ts
/**
 * When the session was active: [startOffsetS, endOffsetS] pairs, in seconds from
 * `startTimestamp`, ascending and non-overlapping. Absent when not derivable (fewer
 * than two events, or the event_times view is unavailable), like `activeMs`.
 */
activeSpans?: [number, number][];
```

- **Offsets in whole seconds from the start**, not ISO strings. A span is then about a
  dozen bytes instead of about fifty, and a minute-scale calendar loses nothing.
- **Capped at 48 spans per session.** Past the cap, the shortest *gaps* are merged
  first, which keeps the shape of the day and drops jitter. `activeMs` is computed
  before the cap, so the number stays exact even when the drawing is simplified.
- **Always present, not opt-in.** The cost is response bytes only: about 50 sessions ×
  ~10 spans × ~12 bytes ≈ 6 KB on a list page, and at most ~300 KB on a full 500-session
  calendar month at the cap, before gzip. An opt-in query parameter (`?spans=1`) is the
  alternative if that turns out to matter. It costs a parameter to keep in step across
  two views, and the list wants the spans too (section 4).

Regenerate the clients (`gen:clients`). The CLI gets the field for free in `sessions
--json`, which suits agents asking "when did I work on X last week".

### 3. Draw them in the calendar

- The bar's outline keeps its runtime extent, drawn faint, so "open from 10:00 to 18:00"
  still reads.
- Filled segments in the project colour mark the active spans. Points get a 2 px minimum
  width.
- A session crossing midnight clips its spans to each day's lane, as the bar already
  does (`groupByOverlap`).
- Opacity no longer encodes the active share, because the fill now shows it directly.
  The legend's "brighter bar = more of its runtime active" goes.
- The hover card's daylight figure becomes the share of *active* time in daylight, which
  is the more honest number: hours a terminal sat open overnight shouldn't count as
  night work.

### 4. And in the list

`ActiveBar` becomes a miniature of the same timeline: the runtime as the track, with the
spans filled. It is the same component in a smaller box, so the two views agree.

## Caveats

- **"Active" means "events were arriving".** A single tool call or model turn that runs
  longer than the idle threshold with no hook events in between shows as a gap. This is
  the existing `activeMs` behaviour, not a new error, and the threshold is configurable.
  Drawing it makes it more visible, which is honest, but worth a line in
  `docs/use/web-ui.md`.
- **A changed threshold reshapes history.** The spans depend on
  `idleThresholdMs`, as `activeMs` already does. The memo already keys on the threshold.
- **Sessions read from their summary doc** get spans the same way, because the
  enrichment runs after the summary is resolved (`withActiveDurations` in
  `routes/sessions.ts`).

## Not in this proposal

- **Kinds of activity** (your prompts vs. the agent working). `event_times` values are
  bare timestamps. Telling them apart would mean emitting `[timestamp, kind]` from the
  view, which is a view change and so a migration. Worth doing later for prompt ticks on
  the bar, and the field above leaves room for it: a sibling `promptOffsets?: number[]`.
- **A first-prompt label for the session.** It's the best caption for a bar, but it
  comes from transcript or prompt docs, not timestamps, and has its own cost question.
  It's a separate RFC.

## Open questions

1. Is 48 the right cap? It's enough to show a working day in five-minute resolution
   with breaks. Measure the span count distribution on a real corpus before fixing it.
2. Should points (single events) be drawn at all, or folded into the nearest span when
   they're within, say, two thresholds of it?
3. If this is accepted, it becomes an ADR. It adds to the API contract, and fixes what
   "active" means as a set of spans rather than a total.

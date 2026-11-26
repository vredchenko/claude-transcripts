# 34. Active time is a set of spans, derived on read

Date: 2026-11-26

## Status

Accepted. Proposed in `rfcs/2026-11-26-activity-spans.md`.

## Context

A session's runtime runs from its first event to its last, and that counts the hours it
sat open in a terminal doing nothing. `activeMs` corrected the *total*: runtime minus
every gap between events longer than `system.sessions.idleThresholdMs`. It said nothing
about *when*. The calendar drew a session left open over a weekend, worked on for an
hour on Friday and an hour on Monday, as one solid three-day bar, and only its opacity
hinted that most of it was idle.

`activeMs` was never stored. The webapi derived it on every read from every event's
timestamp (the `session_index/event_times` view), memoised per session. The stretches
of activity are a by-product of that same pass.

Measured on a real corpus of about 800 sessions with the default 5-minute threshold, a
session had a median of 3 active spans, a 99th percentile of 30 and a maximum of 45.
About one span in ten was a single event.

## Decision

- **"Active" is defined as a set of spans.** `activeSpans(timestamps, idleMs)` in
  `@claude-transcripts/shared` sorts a session's event timestamps and cuts them wherever
  two consecutive events are more than the threshold apart. Each run is one span from
  its first event to its last; a lone event is a zero-length span (a point) and is kept.
  `sumActiveDurationMs` is the sum of the spans' lengths, so there is one definition of
  active time, and a test checks it equals the gap-sum it replaced.
- **Derived on read, never stored.** The webapi computes spans where it computed
  `activeMs`, from the rows it already reads, and memoises them under the same key
  (session, newest timestamp, threshold). There is no new view, no migration and no
  change to any stored document, so the append-only rule is untouched.
- **Served on `SessionSummary` as `activeSpans`**: `[startOffsetS, endOffsetS]` pairs in
  whole seconds from the session's start (`startTimestamp`, else `timestamp`),
  ascending, present whenever `activeMs` is. Seconds from the start are about a quarter
  the size of ISO strings and lose nothing at the scale anything draws.
- **Capped at 48 per session** (`MAX_ACTIVE_SPANS`) by closing the shortest gaps first.
  The cap is a guard; the corpus above never reached it. `activeMs` is summed before the
  cap, so the total stays exact when a drawing is simplified.
- **Always present, not opt-in.** The cost is response bytes, about 70 bytes for a
  typical session. Both the calendar and the list draw it.
- **Drawn the same way in both views.** A calendar bar is faint across the time the
  session was open and filled where it was active, with points at a 2 px minimum width.
  The list's runtime bar is the same timeline in miniature. Where `activeSpans` is
  absent, both fall back to showing the active share as before. The calendar's daylight
  figure is the share of *active* time in daylight.

## Consequences

- The calendar shows when work happened, so a weekend left open no longer looks like a
  weekend of work, and two sessions that overlap on paper can be seen to have
  alternated.
- `sessions --json` carries the spans, so an agent can answer "when did I work on X"
  without fetching a transcript.
- "Active" still means "events were arriving". A single tool call or model turn longer
  than the threshold, with no hook events inside it, shows as a gap. That was already
  true of `activeMs`; drawing it makes it visible, and the threshold is configurable.
- Changing `idleThresholdMs` reshapes every session's spans as it already reshaped its
  total. The memo is keyed on the threshold, so nothing stale is served.
- Telling kinds of activity apart (your prompts vs. the agent working) would need the
  `event_times` view to emit a kind with each timestamp, which is a view change and a
  migration. The field leaves room for a sibling such as `promptOffsets`.

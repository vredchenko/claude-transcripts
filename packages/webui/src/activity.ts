/**
 * When a session was active, for drawing: the API's `activeSpans` (second offsets from
 * the session's start) turned back into instants, clipped to whatever a bar covers, and
 * placed as percentages along it.
 */
import { type DaylightPlace, daylightShare } from "./daylight";

/** `[start, end]` in epoch ms. `start === end` is a single event, a point. */
export type Span = [number, number];

/** A span placed along a bar, 0–100. `widthPct` is 0 for a point. */
export interface Segment {
  leftPct: number;
  widthPct: number;
}

/**
 * The session's active spans as epoch ms, or undefined when the API didn't derive them
 * (too few events, an instance without the view, a session with no start).
 */
export function sessionSpans(s: {
  startTimestamp?: string;
  timestamp: string;
  activeSpans?: number[][];
}): Span[] | undefined {
  if (!s.activeSpans?.length) return undefined;
  const start = Date.parse(s.startTimestamp ?? s.timestamp);
  if (Number.isNaN(start)) return undefined;
  const spans: Span[] = [];
  for (const pair of s.activeSpans) {
    const [from, to] = pair;
    if (typeof from !== "number" || typeof to !== "number" || to < from) continue;
    spans.push([start + from * 1000, start + to * 1000]);
  }
  return spans.length ? spans : undefined;
}

/**
 * `spans` clipped to `[from, to]` and placed as percentages of it. A span that only
 * touches the range at a single instant is dropped unless it was a point to begin with,
 * so a session that ran up to midnight doesn't leave a stray tick on the next day.
 */
export function segmentsIn(spans: Span[], from: number, to: number): Segment[] {
  const length = to - from;
  if (!(length > 0)) return [];
  const segments: Segment[] = [];
  for (const [start, end] of spans) {
    const point = start === end;
    if (point ? start < from || start > to : end <= from || start >= to) continue;
    const a = Math.max(start, from);
    const b = Math.min(end, to);
    segments.push({ leftPct: ((a - from) / length) * 100, widthPct: ((b - a) / length) * 100 });
  }
  return segments;
}

/**
 * The share of the session's *active* time that fell in daylight, 0–1. Hours a terminal
 * sat open overnight don't make it night work. Undefined when there's no active time to
 * weigh (no spans, or only single events).
 */
export function activeDaylightShare(spans: Span[], place: DaylightPlace): number | undefined {
  let total = 0;
  let lit = 0;
  for (const [start, end] of spans) {
    const length = end - start;
    if (length <= 0) continue;
    total += length;
    lit += (daylightShare(start, end, place.location) ?? 0) * length;
  }
  return total > 0 ? lit / total : undefined;
}

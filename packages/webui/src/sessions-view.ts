/**
 * The arithmetic behind the timeline and calendar projections of the session list.
 *
 * Kept pure and out of the components for the same reason `search-query.ts` is: this is
 * where the bugs live. A session is an *interval*, not a point — the corpus routinely
 * holds one that ran for four days — and every interesting mistake here is a silent
 * one. A calendar that places a session by its start date alone simply doesn't draw
 * three of its four days, and looks perfectly fine doing it.
 *
 * Everything works in **local time**, because the question a reader is asking is "what
 * was I doing on Tuesday", and Tuesday is a local idea. Every function that needs "now"
 * takes it as an argument rather than calling `Date.now()`, so a running session's
 * extent is testable.
 */

/** Enough of a session to place it on an axis. */
export interface PlaceableSession {
  sessionId: string;
  timestamp: string;
  startTimestamp?: string;
  durationMs?: number;
  lastActivity?: string;
  status?: string;
}

/** A session reduced to the span of wall-clock time it occupied. */
export interface Interval {
  sessionId: string;
  /** epoch ms */
  start: number;
  /** epoch ms; always >= start */
  end: number;
}

export const MINUTE_MS = 60_000;
export const HOUR_MS = 60 * MINUTE_MS;
export const DAY_MS = 24 * HOUR_MS;

/** Parse an ISO timestamp to epoch ms, or NaN. */
function parse(iso: string | undefined): number {
  if (!iso) return Number.NaN;
  return Date.parse(iso);
}

/**
 * When a session started and stopped.
 *
 * The API reports these three ways and all of them occur: an ended session has a start
 * and a duration; a running one has a start and a `lastActivity` that keeps moving; and
 * a session that crashed before its summary was written has a start and nothing else.
 * The last case is why the fallback is `now` rather than zero — drawing a crashed
 * session as instantaneous would hide it entirely on a time axis.
 */
export function toInterval(session: PlaceableSession, now: number): Interval {
  const start = parse(session.startTimestamp ?? session.timestamp);
  const safeStart = Number.isNaN(start) ? now : start;

  const byDuration = session.durationMs ? safeStart + session.durationMs : Number.NaN;
  const byActivity = parse(session.lastActivity);
  const byTimestamp = parse(session.timestamp);

  const candidates = [byDuration, byActivity, byTimestamp].filter(
    (v) => !Number.isNaN(v) && v >= safeStart,
  );
  // A running session is still going: it reaches to now, even if its last recorded
  // activity was a while back.
  const end = session.status === "running" ? now : Math.max(safeStart, ...candidates);
  return { sessionId: session.sessionId, start: safeStart, end: Math.max(safeStart, end) };
}

/** Local midnight starting the day that contains `ms`. */
export function startOfDay(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/**
 * Local-time `YYYY-MM-DD` for an instant.
 *
 * Not `toISOString().slice(0, 10)`, which is UTC: west of Greenwich that files an
 * evening session under the following day.
 */
export function dayKey(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** `YYYY-MM` for an instant, in local time. */
export function monthKey(ms: number): string {
  return dayKey(ms).slice(0, 7);
}

/** Parse `YYYY-MM` to the local first-of-month instant; invalid input → `fallback`. */
export function parseMonth(key: string | undefined, fallback: number): number {
  const match = /^(\d{4})-(\d{2})$/.exec(key ?? "");
  if (!match) return startOfMonth(fallback);
  const year = Number(match[1]);
  const month = Number(match[2]);
  if (month < 1 || month > 12) return startOfMonth(fallback);
  return new Date(year, month - 1, 1).getTime();
}

/** Parse `YYYY-MM-DD` to local midnight; invalid input → undefined. */
export function parseDay(key: string | undefined): number | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key ?? "");
  if (!match) return undefined;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  if (month < 1 || month > 12 || day < 1 || day > 31) return undefined;
  const at = new Date(year, month - 1, day);
  // Reject a date the calendar rolled over (2026-02-31 → 3 March).
  if (at.getMonth() !== month - 1 || at.getDate() !== day) return undefined;
  return at.getTime();
}

/** Local first-of-month instant for the month containing `ms`. */
export function startOfMonth(ms: number): number {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), 1).getTime();
}

/** Step a month key by `delta` months, staying valid across year boundaries. */
export function shiftMonth(monthStart: number, delta: number): number {
  const d = new Date(monthStart);
  return new Date(d.getFullYear(), d.getMonth() + delta, 1).getTime();
}

/**
 * The weeks a month grid shows: whole weeks, Monday-first, covering the month and the
 * neighbouring days that complete its first and last rows.
 *
 * Always 6 rows. A month can genuinely need 6 (a 31-day month starting on a Sunday), so
 * the alternative is a grid whose height jumps as you page through months, which makes
 * the controls move under the cursor.
 */
export function monthWeeks(monthStart: number): number[][] {
  const first = new Date(monthStart);
  // getDay() is Sunday-0; shift so Monday is column 0.
  const leading = (first.getDay() + 6) % 7;
  const gridStart = new Date(first.getFullYear(), first.getMonth(), 1 - leading);

  const weeks: number[][] = [];
  for (let week = 0; week < 6; week++) {
    const days: number[] = [];
    for (let day = 0; day < 7; day++) {
      // Constructed per-cell rather than by adding 86_400_000, so DST transitions
      // (a 23- or 25-hour day) don't drift the grid by an hour.
      days.push(
        new Date(
          gridStart.getFullYear(),
          gridStart.getMonth(),
          gridStart.getDate() + week * 7 + day,
        ).getTime(),
      );
    }
    weeks.push(days);
  }
  return weeks;
}

/** Does the interval cover any part of the local day starting at `dayStart`? */
export function overlapsDay(interval: Interval, dayStart: number): boolean {
  const dayEnd = new Date(
    new Date(dayStart).getFullYear(),
    new Date(dayStart).getMonth(),
    new Date(dayStart).getDate() + 1,
  ).getTime();
  // Half-open: a session ending exactly at midnight belongs to the day it ran in, not
  // to the next one, which would otherwise show a zero-length sliver at its top.
  return interval.start < dayEnd && interval.end > dayStart;
}

/**
 * A bar in one week row of the month grid: which columns it covers, and whether it
 * runs on past either end of the row.
 */
export interface WeekBar extends Interval {
  /** 0–6, Monday-first. */
  column: number;
  /** How many columns the bar covers, at least 1. */
  span: number;
  /** The session started before this week — draw the left end open. */
  continuesLeft: boolean;
  /** The session ends after this week — draw the right end open. */
  continuesRight: boolean;
  /** Stacking row within the cell, so overlapping sessions don't sit on top of
   *  each other. */
  lane: number;
}

/**
 * Place intervals as bars across one week row, assigning each a lane so that no two
 * overlapping bars share one.
 *
 * Greedy first-fit over intervals sorted by start, which is the standard approach and
 * gives the minimum number of lanes for a set of intervals. Sorting matters: without
 * it, a long session processed late is forced into a high lane and every bar below it
 * is pushed down for no reason.
 */
export function weekBars(week: number[], intervals: Interval[]): WeekBar[] {
  const weekStart = week[0];
  const lastDay = week[6];
  if (weekStart === undefined || lastDay === undefined) return [];
  const weekEnd = new Date(
    new Date(lastDay).getFullYear(),
    new Date(lastDay).getMonth(),
    new Date(lastDay).getDate() + 1,
  ).getTime();

  const inWeek = intervals
    .filter((i) => i.start < weekEnd && i.end > weekStart)
    .sort((a, b) => a.start - b.start || a.end - b.end);

  /** Last-occupied column per lane, so a new bar can find the first lane that's free. */
  const laneEnds: number[] = [];
  const bars: WeekBar[] = [];

  for (const interval of inWeek) {
    let column = week.findIndex((day) => overlapsDay(interval, day));
    if (column === -1) column = 0;
    let lastColumn = column;
    for (let i = column; i < 7; i++) {
      const day = week[i];
      if (day !== undefined && overlapsDay(interval, day)) lastColumn = i;
    }

    let lane = laneEnds.findIndex((end) => end < column);
    if (lane === -1) lane = laneEnds.length;
    laneEnds[lane] = lastColumn;

    bars.push({
      ...interval,
      column,
      span: lastColumn - column + 1,
      continuesLeft: interval.start < weekStart,
      continuesRight: interval.end > weekEnd,
      lane,
    });
  }
  return bars;
}

/** Where an interval sits within a single day, as percentages of the 24-hour column. */
export interface DayPlacement {
  /** Distance from the top of the day, 0–100. */
  topPct: number;
  /** Height as a percentage of the day; never 0, so a brief session stays visible. */
  heightPct: number;
  /** The session began before this day. */
  startsEarlier: boolean;
  /** The session continues past this day. */
  endsLater: boolean;
  /** Column index among sessions running at the same time. */
  lane: number;
  /** How many lanes the day needs in total, so a caller can size the columns. */
  laneCount: number;
}

/** The smallest a bar may be drawn, as a fraction of the day (≈7 minutes). */
const MIN_HEIGHT_PCT = 0.5;

/**
 * Lay out one day of a time-grid: each interval clipped to the day, positioned by
 * clock time, and assigned a lane so concurrent sessions sit side by side.
 *
 * A day is not always 24 hours — DST makes one 23 and another 25 — so positions are
 * computed against the day's *actual* length rather than a constant. Getting this wrong
 * shifts every bar by an hour twice a year, which reads as data corruption.
 */
export function dayPlacements(dayStart: number, intervals: Interval[]): Map<string, DayPlacement> {
  const at = new Date(dayStart);
  const dayEnd = new Date(at.getFullYear(), at.getMonth(), at.getDate() + 1).getTime();
  const dayLength = dayEnd - dayStart;

  const inDay = intervals
    .filter((i) => i.start < dayEnd && i.end > dayStart)
    .sort((a, b) => a.start - b.start || a.end - b.end);

  /** Clipped end per lane, so a later interval can reuse a lane that has finished. */
  const laneEnds: number[] = [];
  const placements = new Map<string, DayPlacement>();

  for (const interval of inDay) {
    const start = Math.max(interval.start, dayStart);
    const end = Math.min(interval.end, dayEnd);

    let lane = laneEnds.findIndex((laneEnd) => laneEnd <= start);
    if (lane === -1) lane = laneEnds.length;
    laneEnds[lane] = end;

    placements.set(interval.sessionId, {
      topPct: ((start - dayStart) / dayLength) * 100,
      heightPct: Math.max(MIN_HEIGHT_PCT, ((end - start) / dayLength) * 100),
      startsEarlier: interval.start < dayStart,
      endsLater: interval.end > dayEnd,
      lane,
      laneCount: 0,
    });
  }

  // laneCount is a property of the day, not of one interval, so it can only be filled
  // in once every lane has been claimed.
  for (const placement of placements.values()) placement.laneCount = laneEnds.length;
  return placements;
}

/** Sessions that fall on one local day, newest first within the day. */
export interface DayGroup<T> {
  /** Local midnight. */
  dayStart: number;
  key: string;
  items: T[];
}

/**
 * Group sessions under the day they *started*, most recent day first.
 *
 * By start rather than by overlap: a vertical timeline reads as "what did I begin, and
 * when", and repeating a four-day session under each of its four days would bury the
 * days it merely spilled into. The calendar is the projection that shows extent.
 */
export function groupByDay<T>(items: T[], startOf: (item: T) => number): DayGroup<T>[] {
  const groups = new Map<string, DayGroup<T>>();
  for (const item of items) {
    const dayStart = startOfDay(startOf(item));
    const key = dayKey(dayStart);
    const group = groups.get(key) ?? { dayStart, key, items: [] };
    group.items.push(item);
    groups.set(key, group);
  }
  return [...groups.values()]
    .sort((a, b) => b.dayStart - a.dayStart)
    .map((group) => ({
      ...group,
      items: group.items.sort((a, b) => startOf(b) - startOf(a)),
    }));
}

/**
 * Vertical offsets for the proportional timeline: distance from the previous session,
 * scaled so real gaps are visible without a quiet fortnight becoming a blank screen.
 *
 * Linear spacing is unusable on this data — the gap between two sessions ranges from
 * seconds to months, so any pixels-per-hour that renders a busy afternoon puts the
 * next week's work several thousand pixels below. The square root compresses the long
 * gaps while keeping short ones distinguishable: an hour reads as clearly more than a
 * minute, and a month reads as more than a week without being 30× taller.
 */
export function proportionalGaps(
  intervals: Interval[],
  pixelsPerRootHour = 26,
  maxGapPx = 260,
): number[] {
  return intervals.map((interval, i) => {
    const previous = intervals[i - 1];
    if (!previous) return 0;
    // Newest-first ordering: the previous item is the *later* session.
    const gapMs = Math.max(0, previous.start - interval.end);
    const gapPx = Math.sqrt(gapMs / HOUR_MS) * pixelsPerRootHour;
    return Math.min(maxGapPx, Math.round(gapPx));
  });
}

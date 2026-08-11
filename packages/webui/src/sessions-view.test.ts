import { describe, expect, it } from "bun:test";
import {
  DAY_MS,
  dayKey,
  dayPlacements,
  groupByDay,
  HOUR_MS,
  type Interval,
  MINUTE_MS,
  monthKey,
  monthWeeks,
  overlapsDay,
  parseDay,
  parseMonth,
  proportionalGaps,
  shiftMonth,
  startOfDay,
  startOfMonth,
  toInterval,
  weekBars,
} from "./sessions-view";

/** Local-time instant, so expectations don't depend on the runner's timezone. */
const at = (y: number, m: number, d: number, h = 0, min = 0): number =>
  new Date(y, m - 1, d, h, min).getTime();

const interval = (sessionId: string, start: number, end: number): Interval => ({
  sessionId,
  start,
  end,
});

describe("toInterval", () => {
  const NOW = at(2026, 3, 18, 14, 30);

  it("derives the end from start + duration", () => {
    const i = toInterval(
      {
        sessionId: "a",
        timestamp: new Date(at(2026, 3, 18, 11)).toISOString(),
        startTimestamp: new Date(at(2026, 3, 18, 9)).toISOString(),
        durationMs: 2 * HOUR_MS,
      },
      NOW,
    );
    expect(i.start).toBe(at(2026, 3, 18, 9));
    expect(i.end).toBe(at(2026, 3, 18, 11));
  });

  it("runs a running session up to now", () => {
    // Its last recorded activity is older than now, but it hasn't stopped.
    const i = toInterval(
      {
        sessionId: "a",
        timestamp: new Date(at(2026, 3, 18, 13)).toISOString(),
        startTimestamp: new Date(at(2026, 3, 18, 13)).toISOString(),
        lastActivity: new Date(at(2026, 3, 18, 13, 40)).toISOString(),
        status: "running",
      },
      NOW,
    );
    expect(i.end).toBe(NOW);
  });

  it("falls back to the timestamp when there is no duration", () => {
    // A session that crashed before its summary was written.
    const i = toInterval(
      {
        sessionId: "a",
        timestamp: new Date(at(2026, 3, 18, 12)).toISOString(),
        startTimestamp: new Date(at(2026, 3, 18, 10)).toISOString(),
      },
      NOW,
    );
    expect(i.end).toBe(at(2026, 3, 18, 12));
  });

  it("never ends before it starts", () => {
    // A summary timestamp earlier than the first event would otherwise invert it.
    const i = toInterval(
      {
        sessionId: "a",
        timestamp: new Date(at(2026, 3, 18, 8)).toISOString(),
        startTimestamp: new Date(at(2026, 3, 18, 10)).toISOString(),
      },
      NOW,
    );
    expect(i.end).toBeGreaterThanOrEqual(i.start);
  });

  it("survives an unparseable start", () => {
    const i = toInterval({ sessionId: "a", timestamp: "not a date" }, NOW);
    expect(Number.isNaN(i.start)).toBe(false);
    expect(i.end).toBeGreaterThanOrEqual(i.start);
  });
});

describe("day and month keys", () => {
  it("uses local time, not UTC", () => {
    // The bug this guards: toISOString() on a late-evening instant reports the next
    // day for anyone west of Greenwich.
    const evening = at(2026, 3, 18, 23, 30);
    expect(dayKey(evening)).toBe("2026-03-18");
    expect(monthKey(evening)).toBe("2026-03");
  });

  it("zero-pads single-digit months and days", () => {
    expect(dayKey(at(2026, 1, 5))).toBe("2026-01-05");
  });

  it("startOfDay lands on local midnight", () => {
    expect(startOfDay(at(2026, 3, 18, 17, 45))).toBe(at(2026, 3, 18));
  });

  it("startOfMonth lands on the first", () => {
    expect(startOfMonth(at(2026, 3, 18))).toBe(at(2026, 3, 1));
  });
});

describe("parseMonth / parseDay", () => {
  const FALLBACK = at(2026, 3, 18);

  it("parses a valid month key", () => {
    expect(parseMonth("2026-07", FALLBACK)).toBe(at(2026, 7, 1));
  });

  it("falls back on junk or an impossible month", () => {
    expect(parseMonth(undefined, FALLBACK)).toBe(at(2026, 3, 1));
    expect(parseMonth("nonsense", FALLBACK)).toBe(at(2026, 3, 1));
    expect(parseMonth("2026-13", FALLBACK)).toBe(at(2026, 3, 1));
  });

  it("parses a valid day key", () => {
    expect(parseDay("2026-07-04")).toBe(at(2026, 7, 4));
  });

  it("rejects a date that does not exist", () => {
    // Without the round-trip check this silently becomes 3 March.
    expect(parseDay("2026-02-31")).toBeUndefined();
    expect(parseDay("2026-00-10")).toBeUndefined();
    expect(parseDay("garbage")).toBeUndefined();
  });
});

describe("shiftMonth", () => {
  it("steps forward and back across a year boundary", () => {
    expect(shiftMonth(at(2026, 12, 1), 1)).toBe(at(2027, 1, 1));
    expect(shiftMonth(at(2026, 1, 1), -1)).toBe(at(2025, 12, 1));
  });
});

describe("monthWeeks", () => {
  it("always returns six weeks of seven days", () => {
    for (const month of [at(2026, 2, 1), at(2026, 3, 1), at(2026, 8, 1)]) {
      const weeks = monthWeeks(month);
      expect(weeks).toHaveLength(6);
      for (const week of weeks) expect(week).toHaveLength(7);
    }
  });

  it("starts each week on a Monday", () => {
    for (const week of monthWeeks(at(2026, 3, 1))) {
      expect(new Date(week[0]!).getDay()).toBe(1);
    }
  });

  it("includes the whole month", () => {
    const days = monthWeeks(at(2026, 3, 1))
      .flat()
      .map(dayKey);
    expect(days).toContain("2026-03-01");
    expect(days).toContain("2026-03-31");
  });

  it("pads with the neighbouring months' days", () => {
    // 1 March 2026 is a Sunday, so the first row is almost all February.
    const first = monthWeeks(at(2026, 3, 1))[0]!;
    expect(dayKey(first[0]!)).toBe("2026-02-23");
    expect(dayKey(first[6]!)).toBe("2026-03-01");
  });
});

describe("overlapsDay", () => {
  const day = at(2026, 3, 18);

  it("is true for a session inside the day", () => {
    expect(overlapsDay(interval("a", at(2026, 3, 18, 9), at(2026, 3, 18, 10)), day)).toBe(true);
  });

  it("is true for a session merely passing through", () => {
    // The multi-day case: neither endpoint is in the day.
    expect(overlapsDay(interval("a", at(2026, 3, 16), at(2026, 3, 20)), day)).toBe(true);
  });

  it("is false for a session that ends exactly at midnight", () => {
    // Half-open, so it doesn't paint a zero-length sliver on the following day.
    expect(overlapsDay(interval("a", at(2026, 3, 17, 20), at(2026, 3, 18)), day)).toBe(false);
  });

  it("is false either side of the day", () => {
    expect(overlapsDay(interval("a", at(2026, 3, 19), at(2026, 3, 19, 1)), day)).toBe(false);
    expect(overlapsDay(interval("a", at(2026, 3, 17), at(2026, 3, 17, 5)), day)).toBe(false);
  });
});

describe("weekBars", () => {
  // Mon 16 – Sun 22 March 2026.
  const week = monthWeeks(at(2026, 3, 1))[3]!;

  it("spans every day a session covers", () => {
    const bars = weekBars(week, [interval("a", at(2026, 3, 17, 9), at(2026, 3, 19, 14))]);
    expect(bars).toHaveLength(1);
    // Tue is column 1, through Thu — three columns, not one.
    expect(bars[0]!.column).toBe(1);
    expect(bars[0]!.span).toBe(3);
  });

  it("marks a session that runs in from the previous week", () => {
    const bars = weekBars(week, [interval("a", at(2026, 3, 14), at(2026, 3, 17, 12))]);
    expect(bars[0]!.continuesLeft).toBe(true);
    expect(bars[0]!.continuesRight).toBe(false);
    expect(bars[0]!.column).toBe(0);
  });

  it("marks a session that runs out into the next week", () => {
    const bars = weekBars(week, [interval("a", at(2026, 3, 21), at(2026, 3, 25))]);
    expect(bars[0]!.continuesRight).toBe(true);
  });

  it("gives overlapping sessions separate lanes", () => {
    const bars = weekBars(week, [
      interval("a", at(2026, 3, 16, 9), at(2026, 3, 18, 9)),
      interval("b", at(2026, 3, 17, 9), at(2026, 3, 19, 9)),
    ]);
    expect(new Set(bars.map((b) => b.lane)).size).toBe(2);
  });

  it("reuses a lane once the earlier session has finished", () => {
    const bars = weekBars(week, [
      interval("a", at(2026, 3, 16, 9), at(2026, 3, 16, 17)),
      interval("b", at(2026, 3, 20, 9), at(2026, 3, 20, 17)),
    ]);
    expect(bars.every((b) => b.lane === 0)).toBe(true);
  });

  it("ignores sessions outside the week", () => {
    expect(weekBars(week, [interval("a", at(2026, 3, 1), at(2026, 3, 2))])).toEqual([]);
  });
});

describe("dayPlacements", () => {
  const day = at(2026, 3, 18);

  it("positions a session by clock time", () => {
    const placed = dayPlacements(day, [interval("a", at(2026, 3, 18, 6), at(2026, 3, 18, 12))]).get(
      "a",
    )!;
    expect(placed.topPct).toBeCloseTo(25, 5);
    expect(placed.heightPct).toBeCloseTo(25, 5);
  });

  it("clips a session that spans into and out of the day", () => {
    const placed = dayPlacements(day, [interval("a", at(2026, 3, 16), at(2026, 3, 20))]).get("a")!;
    expect(placed.topPct).toBe(0);
    expect(placed.heightPct).toBeCloseTo(100, 5);
    expect(placed.startsEarlier).toBe(true);
    expect(placed.endsLater).toBe(true);
  });

  it("keeps a very brief session visible", () => {
    // Four seconds is 0.005% of a day; drawn to scale it would be invisible.
    const placed = dayPlacements(day, [
      interval("a", at(2026, 3, 18, 9), at(2026, 3, 18, 9) + 4000),
    ]).get("a")!;
    expect(placed.heightPct).toBeGreaterThan(0);
  });

  it("puts concurrent sessions in different lanes and reports the count", () => {
    const placed = dayPlacements(day, [
      interval("a", at(2026, 3, 18, 9), at(2026, 3, 18, 17)),
      interval("b", at(2026, 3, 18, 10), at(2026, 3, 18, 12)),
    ]);
    expect(placed.get("a")!.lane).not.toBe(placed.get("b")!.lane);
    expect(placed.get("a")!.laneCount).toBe(2);
    expect(placed.get("b")!.laneCount).toBe(2);
  });

  it("reuses a lane for sessions that don't overlap", () => {
    const placed = dayPlacements(day, [
      interval("a", at(2026, 3, 18, 9), at(2026, 3, 18, 10)),
      interval("b", at(2026, 3, 18, 11), at(2026, 3, 18, 12)),
    ]);
    expect(placed.get("a")!.lane).toBe(0);
    expect(placed.get("b")!.lane).toBe(0);
    expect(placed.get("a")!.laneCount).toBe(1);
  });

  it("omits sessions from other days", () => {
    expect(dayPlacements(day, [interval("a", at(2026, 3, 20), at(2026, 3, 21))]).size).toBe(0);
  });
});

describe("groupByDay", () => {
  it("groups by start day, newest day first", () => {
    const items = [
      { id: "a", start: at(2026, 3, 18, 9) },
      { id: "b", start: at(2026, 3, 16, 9) },
      { id: "c", start: at(2026, 3, 18, 15) },
    ];
    const groups = groupByDay(items, (i) => i.start);
    expect(groups.map((g) => g.key)).toEqual(["2026-03-18", "2026-03-16"]);
    // Newest first within the day too.
    expect(groups[0]!.items.map((i) => i.id)).toEqual(["c", "a"]);
  });

  it("returns nothing for no items", () => {
    expect(groupByDay([], () => 0)).toEqual([]);
  });
});

describe("proportionalGaps", () => {
  it("gives the first session no leading gap", () => {
    expect(proportionalGaps([interval("a", at(2026, 3, 18), at(2026, 3, 18, 1))])[0]).toBe(0);
  });

  it("grows with the gap, but sub-linearly", () => {
    // Newest first: each session precedes the older one in the array.
    const build = (gapHours: number) => [
      interval("new", at(2026, 3, 18, 12), at(2026, 3, 18, 13)),
      interval(
        "old",
        at(2026, 3, 18, 12) - gapHours * HOUR_MS - HOUR_MS,
        at(2026, 3, 18, 12) - gapHours * HOUR_MS,
      ),
    ];
    const oneHour = proportionalGaps(build(1))[1]!;
    const fourHours = proportionalGaps(build(4))[1]!;
    expect(fourHours).toBeGreaterThan(oneHour);
    // Four times the gap is twice the distance, not four times.
    expect(fourHours).toBeLessThan(oneHour * 4);
  });

  it("caps the gap so a quiet month is not a blank screen", () => {
    const gaps = proportionalGaps([
      interval("new", at(2026, 3, 18), at(2026, 3, 18, 1)),
      interval("old", at(2026, 3, 18) - 200 * DAY_MS, at(2026, 3, 18) - 200 * DAY_MS + HOUR_MS),
    ]);
    expect(gaps[1]).toBeLessThanOrEqual(260);
  });

  it("does not go negative when sessions overlap", () => {
    const gaps = proportionalGaps([
      interval("new", at(2026, 3, 18, 9), at(2026, 3, 18, 17)),
      interval("old", at(2026, 3, 18, 8), at(2026, 3, 18, 12)),
    ]);
    expect(gaps[1]).toBe(0);
  });

  it("treats a minute-scale gap as small but present", () => {
    const gaps = proportionalGaps([
      interval("new", at(2026, 3, 18, 12), at(2026, 3, 18, 13)),
      interval("old", at(2026, 3, 18, 11, 30), at(2026, 3, 18, 12) - 5 * MINUTE_MS),
    ]);
    expect(gaps[1]).toBeGreaterThanOrEqual(0);
    expect(gaps[1]).toBeLessThan(30);
  });
});

import { describe, expect, it } from "bun:test";
import { activeDaylightShare, segmentsIn, sessionSpans } from "./activity";

const START = "2026-06-21T10:00:00.000Z";
const t0 = Date.parse(START);
const MIN = 60_000;

describe("sessionSpans", () => {
  it("turns second offsets back into instants", () => {
    expect(
      sessionSpans({
        timestamp: START,
        activeSpans: [
          [0, 60],
          [600, 600],
        ],
      }),
    ).toEqual([
      [t0, t0 + MIN],
      [t0 + 10 * MIN, t0 + 10 * MIN],
    ]);
  });

  it("prefers startTimestamp over timestamp", () => {
    const spans = sessionSpans({
      startTimestamp: START,
      timestamp: "2026-06-21T12:00:00.000Z",
      activeSpans: [[0, 1]],
    });
    expect(spans?.[0]?.[0]).toBe(t0);
  });

  it("is undefined when there's nothing to draw", () => {
    expect(sessionSpans({ timestamp: START })).toBeUndefined();
    expect(sessionSpans({ timestamp: START, activeSpans: [] })).toBeUndefined();
    expect(sessionSpans({ timestamp: "junk", activeSpans: [[0, 1]] })).toBeUndefined();
    expect(sessionSpans({ timestamp: START, activeSpans: [[5, 1], [3]] })).toBeUndefined();
  });
});

describe("segmentsIn", () => {
  it("places spans as percentages of the range", () => {
    expect(
      segmentsIn(
        [
          [t0, t0 + 10 * MIN],
          [t0 + 50 * MIN, t0 + 50 * MIN],
        ],
        t0,
        t0 + 100 * MIN,
      ),
    ).toEqual([
      { leftPct: 0, widthPct: 10 },
      { leftPct: 50, widthPct: 0 },
    ]);
  });

  it("clips a span that crosses the edge of the range", () => {
    expect(segmentsIn([[t0 - 10 * MIN, t0 + 10 * MIN]], t0, t0 + 100 * MIN)).toEqual([
      { leftPct: 0, widthPct: 10 },
    ]);
  });

  it("drops a span that only touches the range at its edge", () => {
    // Ran up to midnight: nothing to draw on the next day.
    expect(segmentsIn([[t0 - 10 * MIN, t0]], t0, t0 + 100 * MIN)).toEqual([]);
    // …but a single event at exactly the start is drawn.
    expect(segmentsIn([[t0, t0]], t0, t0 + 100 * MIN)).toEqual([{ leftPct: 0, widthPct: 0 }]);
  });

  it("draws nothing in an empty range", () => {
    expect(segmentsIn([[t0, t0 + MIN]], t0, t0)).toEqual([]);
  });
});

describe("activeDaylightShare", () => {
  const LONDON = { location: { latitude: 51.51, longitude: -0.13 }, source: "config" as const };
  const at = (h: number) => Date.UTC(2026, 5, 21, h);

  it("weighs only the active time", () => {
    // An hour at midday and an hour at 1am: half the active time was in daylight, however
    // long the session sat open in between.
    expect(
      activeDaylightShare(
        [
          [at(12), at(13)],
          [at(1), at(2)],
        ],
        LONDON,
      ),
    ).toBeCloseTo(0.5, 5);
  });

  it("has nothing to weigh with only single events", () => {
    expect(activeDaylightShare([[at(12), at(12)]], LONDON)).toBeUndefined();
  });
});

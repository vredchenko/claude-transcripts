/**
 * The formatting decisions that carry meaning rather than style.
 *
 * `durationSplit` is here because it is the one that can lie: every projection of the
 * session list draws a bar or a column from it, and the failure modes (a negative idle
 * segment, an unknown active time rendered as zero) look like data rather than like a
 * bug.
 */
import { describe, expect, test } from "bun:test";
import { durationSplit, durationSplitLabel, formatDuration } from "./format";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

describe("durationSplit", () => {
  test("divides a runtime into active and idle", () => {
    const split = durationSplit(HOUR, 15 * MINUTE);
    expect(split.totalMs).toBe(HOUR);
    expect(split.activeMs).toBe(15 * MINUTE);
    expect(split.idleMs).toBe(45 * MINUTE);
    expect(split.activePct).toBe(25);
  });

  test("reports no split when active time is unknown", () => {
    // Undefined is not zero: a session whose active time the API couldn't derive must
    // not be drawn as one that sat idle for its whole run.
    const split = durationSplit(HOUR, undefined);
    expect(split.totalMs).toBe(HOUR);
    expect(split.activeMs).toBeUndefined();
    expect(split.idleMs).toBeUndefined();
    expect(split.activePct).toBeUndefined();
  });

  test("never produces negative idle when active overshoots the runtime", () => {
    // The two figures come from different timestamps and can disagree by a rounding
    // step; the split widens the total rather than drawing a bar backwards.
    const split = durationSplit(HOUR, HOUR + 1_000);
    expect(split.totalMs).toBe(HOUR + 1_000);
    expect(split.idleMs).toBe(0);
    expect(split.activePct).toBe(100);
  });

  test("falls back to the active figure when there is no runtime", () => {
    const split = durationSplit(undefined, 5 * MINUTE);
    expect(split.totalMs).toBe(5 * MINUTE);
    expect(split.idleMs).toBe(0);
  });

  test("survives a session with nothing recorded at all", () => {
    expect(durationSplit(undefined, undefined)).toEqual({ totalMs: 0 });
    expect(durationSplit(0, 0)).toEqual({ totalMs: 0, activeMs: 0, idleMs: 0 });
  });

  test("clamps a negative runtime rather than propagating it", () => {
    expect(durationSplit(-1, undefined).totalMs).toBe(0);
  });
});

describe("durationSplitLabel", () => {
  test("states all three figures and the share", () => {
    expect(durationSplitLabel(HOUR, 15 * MINUTE)).toBe(
      `${formatDuration(HOUR)} runtime · ${formatDuration(15 * MINUTE)} active (25%) · ${formatDuration(45 * MINUTE)} idle`,
    );
  });

  test("says active time is missing rather than implying it was zero", () => {
    expect(durationSplitLabel(HOUR, undefined)).toContain("not recorded");
  });

  test("has something to say about a session with no runtime", () => {
    expect(durationSplitLabel(undefined, undefined)).toBe("No runtime recorded");
  });
});

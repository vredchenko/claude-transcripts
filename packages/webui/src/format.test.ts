/**
 * The formatting decisions that carry meaning rather than style.
 *
 * `durationSplit` is here because it is the one that can lie: every projection of the
 * session list draws a bar or a column from it, and the failure modes (a negative idle
 * segment, an unknown active time rendered as zero) look like data rather than like a
 * bug.
 */
import { describe, expect, test } from "bun:test";
import { clockTime, durationSplit, durationSplitLabel, statusTime } from "./format";

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
});

describe("durationSplitLabel", () => {
  test("says active time is missing rather than implying it was zero", () => {
    expect(durationSplitLabel(HOUR, undefined)).toContain("not recorded");
  });
});

describe("statusTime", () => {
  const base = {
    timestamp: "2026-10-03T18:00:00.000Z",
    lastActivity: "2026-10-03T18:20:00.000Z",
  };

  test("an ended session reports when it ended", () => {
    expect(statusTime({ ...base, status: "ended" })).toEqual({
      iso: base.timestamp,
      label: "ended",
    });
  });

  test("a live or abandoned session reports its last write", () => {
    for (const status of ["running", "incomplete"]) {
      expect(statusTime({ ...base, status })).toEqual({
        iso: base.lastActivity,
        label: "last write",
      });
    }
  });

  test("falls back to the summary timestamp, and gives up on garbage", () => {
    expect(statusTime({ status: "running", timestamp: base.timestamp })?.iso).toBe(base.timestamp);
    expect(statusTime({ status: "ended", timestamp: "not a date" })).toBeUndefined();
    expect(statusTime({ status: "ended" })).toBeUndefined();
  });
});

describe("clockTime", () => {
  // Local-time construction so the assertions hold in any TZ the tests run in.
  const at = (day: number, h: number, m: number) => new Date(2026, 9, day, h, m).toISOString();

  test("is just the clock on the reference day", () => {
    expect(clockTime(at(3, 9, 5), at(3, 8, 0))).toBe("09:05");
    expect(clockTime(at(3, 9, 5))).toBe("09:05");
  });

  test("names the day when it differs from the reference", () => {
    const out = clockTime(at(4, 1, 30), at(3, 23, 0));
    expect(out.endsWith("01:30")).toBe(true);
    expect(out).not.toBe("01:30");
  });

  test("is empty for missing or invalid input", () => {
    expect(clockTime(undefined)).toBe("");
    expect(clockTime("nope")).toBe("");
  });
});

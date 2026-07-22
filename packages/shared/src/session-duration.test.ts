import { describe, expect, test } from "bun:test";
import { DEFAULT_IDLE_THRESHOLD_MS, sumActiveDurationMs } from "./index";

const t = (sec: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, sec)).toISOString();

describe("sumActiveDurationMs", () => {
  test("returns 0 for fewer than two valid timestamps", () => {
    expect(sumActiveDurationMs([])).toBe(0);
    expect(sumActiveDurationMs([t(0)])).toBe(0);
    expect(sumActiveDurationMs(["not-a-date", "also-bad"])).toBe(0);
  });

  test("sums consecutive gaps within the threshold", () => {
    // 0s → 10s → 25s, all gaps well under 5 min ⇒ 25s active.
    expect(sumActiveDurationMs([t(0), t(10), t(25)], DEFAULT_IDLE_THRESHOLD_MS)).toBe(25_000);
  });

  test("excludes gaps longer than the idle threshold", () => {
    // gaps of 10s (kept) and 20s (excluded, threshold 15s) ⇒ 10s active.
    expect(sumActiveDurationMs([t(0), t(10), t(30)], 15_000)).toBe(10_000);
  });

  test("is order-independent (sorts first)", () => {
    expect(sumActiveDurationMs([t(25), t(0), t(10)], DEFAULT_IDLE_THRESHOLD_MS)).toBe(25_000);
  });

  test("active never exceeds wall-clock; a long idle session collapses to work time", () => {
    // Two quick bursts 1h apart: only the in-burst seconds count as active.
    const stamps = [t(0), t(2), t(3600), t(3602)];
    const active = sumActiveDurationMs(stamps, DEFAULT_IDLE_THRESHOLD_MS);
    const wall = 3602 * 1000;
    expect(active).toBe(4000); // 2s + 2s
    expect(active).toBeLessThan(wall);
  });
});

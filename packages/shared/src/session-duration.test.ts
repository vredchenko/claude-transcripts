import { describe, expect, test } from "bun:test";
import {
  type ActiveSpan,
  activeSpans,
  capActiveSpans,
  DEFAULT_IDLE_THRESHOLD_MS,
  sumActiveDurationMs,
} from "./index";

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
});

/** The gap-sum definition `sumActiveDurationMs` had before spans, kept as the oracle. */
function gapSum(timestamps: string[], idle: number): number {
  const ms = timestamps.map(Date.parse).filter((n) => !Number.isNaN(n));
  ms.sort((a, b) => a - b);
  let active = 0;
  for (let i = 1; i < ms.length; i++) {
    const gap = ms[i]! - ms[i - 1]!;
    if (gap > 0 && gap <= idle) active += gap;
  }
  return active;
}

describe("activeSpans", () => {
  const ms = (sec: number) => Date.UTC(2026, 0, 1, 0, 0, sec);

  test("is empty for no valid timestamps", () => {
    expect(activeSpans([])).toEqual([]);
    expect(activeSpans(["nope"])).toEqual([]);
  });

  test("cuts at gaps longer than the threshold", () => {
    expect(activeSpans([t(0), t(10), t(30), t(35)], 15_000)).toEqual([
      [ms(0), ms(10)],
      [ms(30), ms(35)],
    ]);
  });

  test("keeps a lone event as a point", () => {
    expect(activeSpans([t(0), t(5), t(100), t(200), t(205)], 15_000)).toEqual([
      [ms(0), ms(5)],
      [ms(100), ms(100)],
      [ms(200), ms(205)],
    ]);
  });

  test("a gap exactly at the threshold is still active", () => {
    expect(activeSpans([t(0), t(15)], 15_000)).toEqual([[ms(0), ms(15)]]);
  });

  test("sums to exactly what the gap-sum definition gave, on random input", () => {
    let seed = 7;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed / 2 ** 31;
    };
    for (let run = 0; run < 200; run++) {
      const n = Math.floor(rand() * 40);
      const stamps = Array.from({ length: n }, () => t(Math.floor(rand() * 4000)));
      const idle = 1000 * Math.floor(1 + rand() * 300);
      expect(sumActiveDurationMs(stamps, idle)).toBe(gapSum(stamps, idle));
    }
  });
});

describe("capActiveSpans", () => {
  const spans = (...pairs: number[][]): ActiveSpan[] => pairs.map(([a, b]) => [a!, b!]);

  test("leaves a short list alone", () => {
    const s = spans([0, 1], [5, 6]);
    expect(capActiveSpans(s, 2)).toBe(s);
  });

  test("closes the shortest gaps first", () => {
    // Gaps: 4, 1, 10 → closing the 1 merges the middle two.
    expect(capActiveSpans(spans([0, 1], [5, 6], [7, 8], [18, 19]), 3)).toEqual(
      spans([0, 1], [5, 8], [18, 19]),
    );
  });

  test("keeps the overall extent, and doesn't touch its input", () => {
    const s = spans([0, 1], [3, 4], [10, 11], [20, 21], [22, 30]);
    const capped = capActiveSpans(s, 2);
    expect(capped).toHaveLength(2);
    expect(capped[0]![0]).toBe(0);
    expect(capped.at(-1)![1]).toBe(30);
    expect(s).toHaveLength(5);
  });
});

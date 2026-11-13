import { describe, expect, test } from "bun:test";
import { type Config, DEFAULT_LIVE_WINDOW_MS, liveWindowMs } from "./config";

const withWindow = (liveWindowMs: unknown) =>
  ({ system: { sessions: { liveWindowMs } } }) as unknown as Config;

describe("liveWindowMs", () => {
  test("defaults to 2 h when unset or invalid", () => {
    expect(liveWindowMs({ system: {} } as unknown as Config)).toBe(DEFAULT_LIVE_WINDOW_MS);
    expect(liveWindowMs(withWindow(0))).toBe(DEFAULT_LIVE_WINDOW_MS);
    expect(liveWindowMs(withWindow("1h"))).toBe(DEFAULT_LIVE_WINDOW_MS);
  });

  test("reads the old template's 24 h as unset", () => {
    expect(liveWindowMs(withWindow(86_400_000))).toBe(DEFAULT_LIVE_WINDOW_MS);
  });

  test("honours any other configured value, 24 h included", () => {
    expect(liveWindowMs(withWindow(1_800_000))).toBe(1_800_000);
    expect(liveWindowMs(withWindow(86_400_001))).toBe(86_400_001);
  });
});

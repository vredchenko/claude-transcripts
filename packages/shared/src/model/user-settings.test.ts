/**
 * The reader tunables' one hard rule: whatever `config.json` says, what comes out is a
 * complete set of usable numbers. They are handed to the gateway as `limit`, so a
 * typo must not turn one page request into a request for the whole corpus — and a
 * nonsense value must not stop the instance from starting.
 */
import { describe, expect, test } from "bun:test";
import { DEFAULT_USER_SETTINGS, resolveUserSettings } from "./user-settings";

describe("resolveUserSettings", () => {
  test("no config → the defaults", () => {
    expect(resolveUserSettings(undefined)).toEqual(DEFAULT_USER_SETTINGS);
    expect(resolveUserSettings({})).toEqual(DEFAULT_USER_SETTINGS);
  });

  test("config overrides one field without dropping its siblings", () => {
    const s = resolveUserSettings({ sessionListPageSize: 25 });
    expect(s.sessionListPageSize).toBe(25);
    expect(s.transcriptPageSize).toBe(DEFAULT_USER_SETTINGS.transcriptPageSize);
    expect(s.transcriptAutoLoadMax).toBe(DEFAULT_USER_SETTINGS.transcriptAutoLoadMax);
  });

  test("an oversized page is clamped, not honoured", () => {
    expect(resolveUserSettings({ sessionListPageSize: 100_000 }).sessionListPageSize).toBe(500);
    expect(resolveUserSettings({ transcriptPageSize: 100_000 }).transcriptPageSize).toBe(500);
    expect(resolveUserSettings({ transcriptAutoLoadMax: 1e9 }).transcriptAutoLoadMax).toBe(50_000);
  });

  test("zero, negative and non-numeric fall back rather than throwing", () => {
    for (const bad of [0, -10, Number.NaN, Number.POSITIVE_INFINITY, "50" as unknown as number]) {
      expect(resolveUserSettings({ sessionListPageSize: bad }).sessionListPageSize).toBe(
        DEFAULT_USER_SETTINGS.sessionListPageSize,
      );
    }
  });

  test("a fractional page size is floored to a whole row count", () => {
    expect(resolveUserSettings({ transcriptPageSize: 42.9 }).transcriptPageSize).toBe(42);
  });
});

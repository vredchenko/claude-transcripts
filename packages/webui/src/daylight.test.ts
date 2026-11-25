import { describe, expect, it } from "bun:test";
import { daylightPlace, lightStops, sunDay } from "./daylight";
import { startOfDay } from "./sessions-view";
import { TZ_COORDINATES } from "./tz-coordinates";

const LONDON = { latitude: 51.51, longitude: -0.13 };
const NEW_YORK = { latitude: 40.71, longitude: -74.01 };
const TROMSO = { latitude: 69.65, longitude: 18.96 };
const MINUTE = 60_000;

/** The runner's local day containing that UTC date's noon. */
const dayOf = (y: number, m: number, d: number) => startOfDay(Date.UTC(y, m - 1, d, 12));

/** Within a few minutes of a published almanac time (UTC). */
function near(actual: number | string, y: number, m: number, d: number, h: number, min: number) {
  expect(typeof actual).toBe("number");
  expect(Math.abs((actual as number) - Date.UTC(y, m - 1, d, h, min))).toBeLessThan(4 * MINUTE);
}

describe("sunDay", () => {
  it("matches the almanac at midsummer in London", () => {
    const sun = sunDay(dayOf(2026, 6, 21), LONDON);
    near(sun.sunrise, 2026, 6, 21, 3, 43);
    near(sun.sunset, 2026, 6, 21, 20, 21);
  });

  it("matches the almanac at midwinter in New York", () => {
    const sun = sunDay(dayOf(2026, 12, 21), NEW_YORK);
    near(sun.sunrise, 2026, 12, 21, 12, 17);
    near(sun.sunset, 2026, 12, 21, 21, 32);
  });

  it("puts civil twilight outside sunrise and sunset", () => {
    const sun = sunDay(dayOf(2026, 3, 20), LONDON);
    expect(sun.dawn as number).toBeLessThan(sun.sunrise as number);
    expect(sun.dusk as number).toBeGreaterThan(sun.sunset as number);
  });

  it("knows the midnight sun and the polar night", () => {
    expect(sunDay(dayOf(2026, 6, 21), TROMSO).sunrise).toBe("up");
    const winter = sunDay(dayOf(2026, 12, 21), TROMSO);
    expect(winter.sunrise).toBe("down");
    // …but twilight still comes and goes at 70°N.
    expect(typeof winter.dawn).toBe("number");
  });
});

describe("lightStops", () => {
  it("is dark at both ends of an ordinary day and light in the middle", () => {
    const stops = lightStops(dayOf(2026, 3, 20), LONDON);
    expect(stops[0]).toEqual({ pct: 0, light: 0 });
    expect(stops.at(-1)).toEqual({ pct: 100, light: 0 });
    expect(stops.some((s) => s.light === 1)).toBe(true);
    for (let i = 1; i < stops.length; i++) {
      expect(stops[i]!.pct).toBeGreaterThanOrEqual(stops[i - 1]!.pct);
    }
  });

  it("is flat through the midnight sun", () => {
    expect(lightStops(dayOf(2026, 6, 21), TROMSO).every((s) => s.light === 1)).toBe(true);
  });

  it("never lights the polar night past twilight", () => {
    expect(lightStops(dayOf(2026, 12, 21), TROMSO).every((s) => s.light <= 0.5)).toBe(true);
  });
});

describe("daylightPlace", () => {
  it("prefers the configured location", () => {
    expect(daylightPlace(NEW_YORK, "Europe/London")).toEqual({
      location: NEW_YORK,
      source: "config",
    });
  });

  it("falls back to the time zone's reference point", () => {
    expect(daylightPlace(null, "Europe/London")?.location.latitude).toBeCloseTo(51.5, 0);
  });

  it("knows legacy zone names browsers still report", () => {
    expect(TZ_COORDINATES["Asia/Calcutta"]).toEqual(TZ_COORDINATES["Asia/Kolkata"]!);
  });

  it("gives up on a zone that says nothing about place", () => {
    expect(daylightPlace(null, "UTC")).toBeUndefined();
    expect(daylightPlace(null, "Etc/GMT+3")).toBeUndefined();
    expect(daylightPlace(null, undefined)).toBeUndefined();
  });
});

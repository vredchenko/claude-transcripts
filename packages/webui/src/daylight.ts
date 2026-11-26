/**
 * When the sun is up — for shading the calendar's day lanes by daylight.
 *
 * The sunrise equation (NOAA's low-precision form, as on Wikipedia's "Sunrise equation"):
 * good to a minute or two away from the poles, which is far finer than a lane a few
 * hundred pixels wide can show. No library, no network: given a day and a place it is
 * a dozen lines of trigonometry.
 *
 * Positions are worked out against the *browser's* local day, the same one the lanes
 * are drawn in, so a location configured somewhere else (a server abroad, a trip) still
 * lines up with the clock axis — it just shows that place's daylight at your clock time.
 */
import type { GeoLocation } from "@claude-transcripts/shared";
import { TZ_COORDINATES } from "./tz-coordinates";

const DAY_MS = 86_400_000;
/** Julian date of the Unix epoch. */
const J1970 = 2440587.5;
/** Julian date of J2000.0. */
const J2000 = 2451545;
const RAD = Math.PI / 180;

/** Sun altitudes that bound the light: the visible disc, and civil twilight. */
const SUNRISE_ALTITUDE = -0.833;
const CIVIL_ALTITUDE = -6;

const toJulian = (ms: number) => ms / DAY_MS + J1970;
const fromJulian = (j: number) => (j - J1970) * DAY_MS;

/**
 * The sun's day at a place: when it crosses each altitude going up and coming down.
 *
 * `"up"` / `"down"` stand in for a crossing that doesn't happen that day — the sun never
 * sinks to that altitude (midsummer at high latitude), or never rises to it (midwinter).
 */
export interface SunDay {
  dawn: number | "up" | "down";
  sunrise: number | "up" | "down";
  sunset: number | "up" | "down";
  dusk: number | "up" | "down";
}

/**
 * Sunrise, sunset and civil twilight for the local day starting at `dayStart`, at
 * `location`. The solar noon used is the one nearest the middle of that local day.
 */
export function sunDay(dayStart: number, location: GeoLocation): SunDay {
  const d = new Date(dayStart);
  const dayEnd = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime();
  const localNoon = (dayStart + dayEnd) / 2;
  const { latitude, longitude } = location;

  // Mean solar noon at this longitude, on the cycle nearest local noon.
  const n = Math.round(toJulian(localNoon) - J2000 + longitude / 360);
  const meanNoon = n - longitude / 360;
  const anomaly = (357.5291 + 0.98560028 * meanNoon) % 360;
  const m = anomaly * RAD;
  const centre = 1.9148 * Math.sin(m) + 0.02 * Math.sin(2 * m) + 0.0003 * Math.sin(3 * m);
  const eclipticLongitude = ((anomaly + centre + 180 + 102.9372) % 360) * RAD;
  const transit =
    J2000 + meanNoon + 0.0053 * Math.sin(m) - 0.0069 * Math.sin(2 * eclipticLongitude);
  const declination = Math.asin(Math.sin(eclipticLongitude) * Math.sin(23.4397 * RAD));
  const phi = latitude * RAD;

  /** Half the time the sun spends above `altitude`, as a fraction of a day. */
  const crossing = (altitude: number): [number, number] | "up" | "down" => {
    const cosH =
      (Math.sin(altitude * RAD) - Math.sin(phi) * Math.sin(declination)) /
      (Math.cos(phi) * Math.cos(declination));
    if (cosH < -1) return "up";
    if (cosH > 1) return "down";
    const half = Math.acos(cosH) / (2 * Math.PI);
    return [fromJulian(transit - half), fromJulian(transit + half)];
  };

  const visible = crossing(SUNRISE_ALTITUDE);
  const civil = crossing(CIVIL_ALTITUDE);
  return {
    dawn: typeof civil === "string" ? civil : civil[0],
    sunrise: typeof visible === "string" ? visible : visible[0],
    sunset: typeof visible === "string" ? visible : visible[1],
    dusk: typeof civil === "string" ? civil : civil[1],
  };
}

/** A gradient stop: how light it is (0 night … 1 day) at a point along the day, 0–100. */
export interface LightStop {
  pct: number;
  light: number;
}

/**
 * How light it is across one local day, as stops for a horizontal gradient: night,
 * ramping through civil twilight to full daylight, and back.
 *
 * Crossings that fall outside the day (a location far from the browser's time zone) are
 * clamped to its edges, which is right for what remains visible within the lane.
 */
export function lightStops(dayStart: number, location: GeoLocation): LightStop[] {
  const d = new Date(dayStart);
  const dayEnd = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime();
  const sun = sunDay(dayStart, location);

  // The sun never sets, or never even reaches twilight: one flat level all day.
  if (sun.sunrise === "up") return flat(1);
  if (sun.dawn === "down") return flat(0);

  const pct = (ms: number) =>
    Math.min(100, Math.max(0, ((ms - dayStart) / (dayEnd - dayStart)) * 100));
  // A white night: the sun sets but it never gets darker than twilight.
  const night = sun.dawn === "up" ? 0.5 : 0;
  const dawn = typeof sun.dawn === "number" ? pct(sun.dawn) : 0;
  const dusk = typeof sun.dusk === "number" ? pct(sun.dusk) : 100;

  // Polar twilight: the sun stays below the horizon, but twilight comes and goes.
  if (sun.sunrise === "down") {
    const mid = (dawn + dusk) / 2;
    return [
      { pct: 0, light: night },
      { pct: dawn, light: night },
      { pct: mid, light: 0.5 },
      { pct: dusk, light: night },
      { pct: 100, light: night },
    ];
  }
  const rise = pct(sun.sunrise);
  const set = pct(sun.sunset as number);
  return [
    { pct: 0, light: night },
    { pct: dawn, light: night },
    { pct: rise, light: 1 },
    { pct: set, light: 1 },
    { pct: dusk, light: night },
    { pct: 100, light: night },
  ];
}

function flat(light: number): LightStop[] {
  return [
    { pct: 0, light },
    { pct: 100, light },
  ];
}

/**
 * The share of `[start, end)` that fell between sunrise and sunset at `location`, 0–1,
 * walking it one local day at a time. Twilight counts as dark. Undefined for an empty
 * interval.
 */
export function daylightShare(
  start: number,
  end: number,
  location: GeoLocation,
): number | undefined {
  if (!(end > start)) return undefined;
  let lit = 0;
  let day = new Date(start);
  day.setHours(0, 0, 0, 0);
  while (day.getTime() < end) {
    const dayStart = day.getTime();
    const next = new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1);
    const sun = sunDay(dayStart, location);
    // The day's lit span, as an interval in epoch ms (empty when the sun stays down).
    const [rise, set] =
      sun.sunrise === "up"
        ? [dayStart, next.getTime()]
        : sun.sunrise === "down"
          ? [0, 0]
          : [sun.sunrise, sun.sunset as number];
    lit += Math.max(0, Math.min(end, set) - Math.max(start, rise));
    day = next;
  }
  return lit / (end - start);
}

/** Where the daylight is computed for, and why there. */
export interface DaylightPlace {
  location: GeoLocation;
  /** Configured in `userSettings.location`, or the reference point of this time zone. */
  source: "config" | { timeZone: string };
}

/**
 * The configured location if there is one, else the reference point of the browser's
 * time zone, else nothing — `UTC` or an unknown zone says nothing about where you are,
 * and shading by a guess at Greenwich would be wrong more often than right.
 */
export function daylightPlace(
  configured: GeoLocation | null,
  timeZone: string | undefined,
): DaylightPlace | undefined {
  if (configured) return { location: configured, source: "config" };
  const at = timeZone ? TZ_COORDINATES[timeZone] : undefined;
  if (!at || !timeZone) return undefined;
  return { location: { latitude: at[0], longitude: at[1] }, source: { timeZone } };
}

/** The browser's IANA time zone, when it says. */
export function browserTimeZone(): string | undefined {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined;
  } catch {
    return undefined;
  }
}

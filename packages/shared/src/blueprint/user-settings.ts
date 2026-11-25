/**
 * Reader-facing tunables — how much the webui pulls at a time.
 *
 * These are deployment-wide, non-secret, and belong in `config/` rather than baked
 * into the bundle: how big a page should be depends on the corpus and the machine
 * serving it, and a self-hoster with 20 000 sessions on a Pi should not have to fork
 * the webui to make the list stop fetching a hundred rows at a time.
 *
 * Resolved once in `buildAppBlueprint` and carried on the blueprint, so the views read the
 * settled numbers rather than re-deriving them from config (the same contract
 * `recall` has). Every value is clamped here, because the numbers are handed
 * straight to the gateway as `limit` — an unbounded typo in `config.json` would ask
 * it for the whole corpus in one request.
 */

export interface UserSettings {
  /** Sessions fetched per page as the list scrolls. */
  sessionListPageSize: number;
  /** Transcript entries fetched per page. */
  transcriptPageSize: number;
  /**
   * How many transcript entries the reader will pull on its own — by scrolling or in
   * the background — before it stops and hands the choice back to the reader.
   *
   * A recorded session can run to tens of thousands of entries and nothing here is
   * virtualised yet, so an unbounded auto-loader would happily put all of them in the
   * DOM. Past this point the reader is told what is left and asks for it explicitly.
   */
  transcriptAutoLoadMax: number;
  /**
   * Where the calendar works out sunrise and sunset, for shading each day's lane by
   * daylight. `null` (the default) leaves it to the browser, which takes the reference
   * coordinates of its own time zone — near enough for shading, and right for anyone
   * who lives in the zone's city or close to it. Set it to be exact.
   */
  location: GeoLocation | null;
}

/** A point on the Earth, in decimal degrees (north and east positive). */
export interface GeoLocation {
  latitude: number;
  longitude: number;
}

export const DEFAULT_USER_SETTINGS: UserSettings = {
  sessionListPageSize: 100,
  transcriptPageSize: 100,
  transcriptAutoLoadMax: 2_000,
  location: null,
};

/**
 * Upper bounds, not preferences. A page is one `limit` on one request, so it is
 * capped at something a gateway can answer promptly; the auto-load ceiling is capped
 * at what a browser can hold without virtual scrolling.
 */
type NumericSetting = Exclude<keyof UserSettings, "location">;

const LIMITS: Record<NumericSetting, number> = {
  sessionListPageSize: 500,
  transcriptPageSize: 500,
  transcriptAutoLoadMax: 50_000,
};

/**
 * Config over defaults, with every value clamped to a usable range.
 *
 * A nonsensical value falls back to the default rather than throwing: these are read
 * on the path that builds the blueprint, and a stray `0` in one field should not stop
 * the whole instance from starting.
 */
export function resolveUserSettings(
  fromConfig?: Partial<Omit<UserSettings, "location">> & { location?: unknown },
): UserSettings {
  const c = fromConfig ?? {};
  return {
    sessionListPageSize: clamp(c.sessionListPageSize, "sessionListPageSize"),
    transcriptPageSize: clamp(c.transcriptPageSize, "transcriptPageSize"),
    transcriptAutoLoadMax: clamp(c.transcriptAutoLoadMax, "transcriptAutoLoadMax"),
    location: resolveLocation(c.location),
  };
}

/** A location with both coordinates in range, or `null` — never a half-set one. */
function resolveLocation(value: unknown): GeoLocation | null {
  if (typeof value !== "object" || value === null) return null;
  const { latitude, longitude } = value as Record<string, unknown>;
  if (typeof latitude !== "number" || typeof longitude !== "number") return null;
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  if (Math.abs(latitude) > 90 || Math.abs(longitude) > 180) return null;
  return { latitude, longitude };
}

function clamp(value: number | undefined, key: NumericSetting): number {
  const fallback = DEFAULT_USER_SETTINGS[key];
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  const rounded = Math.floor(value);
  if (rounded < 1) return fallback;
  return Math.min(rounded, LIMITS[key]);
}

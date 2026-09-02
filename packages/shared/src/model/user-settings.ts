/**
 * Reader-facing tunables — how much the webui pulls at a time.
 *
 * These are deployment-wide, non-secret, and belong in `config/` rather than baked
 * into the bundle: how big a page should be depends on the corpus and the machine
 * serving it, and a self-hoster with 20 000 sessions on a Pi should not have to fork
 * the webui to make the list stop fetching a hundred rows at a time.
 *
 * Resolved once in `buildAppModel` and carried on the model, so the views read the
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
}

export const DEFAULT_USER_SETTINGS: UserSettings = {
  sessionListPageSize: 100,
  transcriptPageSize: 100,
  transcriptAutoLoadMax: 2_000,
};

/**
 * Upper bounds, not preferences. A page is one `limit` on one request, so it is
 * capped at something a gateway can answer promptly; the auto-load ceiling is capped
 * at what a browser can hold without virtual scrolling.
 */
const LIMITS = {
  sessionListPageSize: 500,
  transcriptPageSize: 500,
  transcriptAutoLoadMax: 50_000,
} as const;

/**
 * Config over defaults, with every value clamped to a usable range.
 *
 * A nonsensical value falls back to the default rather than throwing: these are read
 * on the path that builds the app model, and a stray `0` in one field should not stop
 * the whole instance from starting.
 */
export function resolveUserSettings(fromConfig?: Partial<UserSettings>): UserSettings {
  const c = fromConfig ?? {};
  return {
    sessionListPageSize: clamp(c.sessionListPageSize, "sessionListPageSize"),
    transcriptPageSize: clamp(c.transcriptPageSize, "transcriptPageSize"),
    transcriptAutoLoadMax: clamp(c.transcriptAutoLoadMax, "transcriptAutoLoadMax"),
  };
}

function clamp(value: number | undefined, key: keyof UserSettings): number {
  const fallback = DEFAULT_USER_SETTINGS[key];
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  const rounded = Math.floor(value);
  if (rounded < 1) return fallback;
  return Math.min(rounded, LIMITS[key]);
}

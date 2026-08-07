/**
 * The pure parts of the search results page: URL state → API params, and paging math.
 *
 * Kept out of the component so they can be tested without a DOM. These are exactly the
 * bits worth testing — an off-by-one in the offset silently skips or repeats a row, and
 * a wrong page count either hides results or offers an empty page.
 */
import type { SearchParams } from "./api/generated";

/** Results per page, per index. Enough to scan, small enough to render instantly. */
export const PAGE_SIZE = 20;

/** The query-string state the `/search` route owns. */
export interface SearchRouteSearch {
  q?: string;
  page?: number;
  cwd?: string;
  model?: string;
  hostname?: string;
  source?: string;
}

/** Filter keys, in the order the page renders their controls. */
export const FILTER_KEYS = ["cwd", "model", "hostname", "source"] as const;
export type FilterKey = (typeof FILTER_KEYS)[number];

/**
 * Project URL state onto the API's query parameters.
 *
 * Empty filters are omitted rather than sent blank: they're part of the react-query
 * cache key, so `?model=` and no model at all must not look like two different queries.
 */
export function toSearchParams(state: SearchRouteSearch, pageSize = PAGE_SIZE): SearchParams {
  const page = pageNumber(state);
  const params: SearchParams = {
    q: (state.q ?? "").trim(),
    limit: pageSize,
    offset: (page - 1) * pageSize,
  };
  for (const key of FILTER_KEYS) {
    const value = state[key];
    if (value) params[key] = value;
  }
  return params;
}

/** Current page, 1-based, defended against junk in the URL. */
export function pageNumber(state: SearchRouteSearch): number {
  const raw = Number(state.page);
  return Number.isFinite(raw) && raw > 1 ? Math.floor(raw) : 1;
}

/**
 * How many pages the pager should offer.
 *
 * Sessions and turns are paged together by one offset, so the count follows whichever
 * index has more matches — stopping at the shorter one would strand the tail of the
 * longer. Always at least 1, so the pager never renders a zero-page control.
 */
export function pageCount(
  totals: { sessions: number; turns: number },
  pageSize = PAGE_SIZE,
): number {
  const most = Math.max(totals.sessions ?? 0, totals.turns ?? 0);
  return Math.max(1, Math.ceil(most / pageSize));
}

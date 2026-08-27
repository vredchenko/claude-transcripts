/**
 * localStorage persistence for omnibox state.
 */

const RECENT_KEY = "ct.recentSearches";
const SAVED_KEY = "ct.savedFilters";
const MAX_RECENT = 5;

export interface SavedFilter {
  name: string;
  query: string;
}

export function getRecentSearches(): string[] {
  try {
    const raw = localStorage.getItem(RECENT_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.slice(0, MAX_RECENT) : [];
  } catch {
    return [];
  }
}

export function addRecentSearch(q: string): void {
  try {
    const recent = getRecentSearches().filter((r) => r !== q);
    recent.unshift(q);
    localStorage.setItem(RECENT_KEY, JSON.stringify(recent.slice(0, MAX_RECENT)));
  } catch {
    // Best-effort.
  }
}

export function getSavedFilters(): SavedFilter[] {
  try {
    const raw = localStorage.getItem(SAVED_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function saveFilter(name: string, query: string): void {
  try {
    const filters = getSavedFilters().filter((f) => f.name !== name);
    filters.push({ name, query });
    localStorage.setItem(SAVED_KEY, JSON.stringify(filters));
  } catch {
    // Best-effort.
  }
}

export function removeFilter(name: string): void {
  try {
    const filters = getSavedFilters().filter((f) => f.name !== name);
    localStorage.setItem(SAVED_KEY, JSON.stringify(filters));
  } catch {
    // Best-effort.
  }
}

import { createRootRoute, createRoute, createRouter } from "@tanstack/react-router";
import { RootLayout } from "./routes/root";
import { SearchResultsPage, type SearchRouteSearch } from "./routes/search-results";
import { SessionDetailPage, type SessionDetailSearch } from "./routes/session-detail";
import {
  SessionsListPage,
  type SessionsRouteSearch,
  type SessionsView,
} from "./routes/sessions-list";

/**
 * Code-based route tree (no file-based router plugin). The app is served under
 * `/app` in prod (Vite `base: "/app/"`), so the router shares that basepath.
 */
const rootRoute = createRootRoute({ component: RootLayout });

const optionalString = (v: unknown): string | undefined =>
  typeof v === "string" && v ? v : undefined;

/**
 * The list route owns which projection is showing and what it's showing — so a
 * calendar month or an active filter is linkable, and the back button steps through
 * them. Unknown values fall back to the defaults rather than rendering nothing.
 */
const listRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: SessionsListPage,
  validateSearch: (search: Record<string, unknown>): SessionsRouteSearch => ({
    view: search.view === "calendar" ? (search.view as SessionsView) : undefined,
    month: optionalString(search.month),
    day: optionalString(search.day),
    cwd: optionalString(search.cwd),
    model: optionalString(search.model),
    hostname: optionalString(search.hostname),
    source: optionalString(search.source),
    from: optionalString(search.from),
    to: optionalString(search.to),
  }),
});

/**
 * The detail route carries the search terms that led here (`?q=`), so arriving from a
 * result lands on the matched turn with the terms marked instead of at the top of a
 * five-thousand-entry transcript.
 */
const detailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/sessions/$id",
  component: SessionDetailPage,
  validateSearch: (search: Record<string, unknown>): SessionDetailSearch => ({
    q: optionalString(search.q),
  }),
});

/**
 * The results page keeps its whole state in the query string, so a result set is
 * linkable and the back button steps through filters and pages.
 */
const searchRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/search",
  component: SearchResultsPage,
  validateSearch: (search: Record<string, unknown>): SearchRouteSearch => ({
    q: optionalString(search.q),
    page: Number(search.page) > 1 ? Number(search.page) : undefined,
    cwd: optionalString(search.cwd),
    model: optionalString(search.model),
    hostname: optionalString(search.hostname),
    source: optionalString(search.source),
  }),
});

const routeTree = rootRoute.addChildren([listRoute, detailRoute, searchRoute]);

export const router = createRouter({ routeTree, basepath: "/app" });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

import { createRootRoute, createRoute, createRouter } from "@tanstack/react-router";
import { RootLayout } from "./routes/root";
import { SearchResultsPage, type SearchRouteSearch } from "./routes/search-results";
import { SessionDetailPage } from "./routes/session-detail";
import { SessionsListPage } from "./routes/sessions-list";

/**
 * Code-based route tree (no file-based router plugin). The app is served under
 * `/app` in prod (Vite `base: "/app/"`), so the router shares that basepath.
 */
const rootRoute = createRootRoute({ component: RootLayout });

const listRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: SessionsListPage,
});

const detailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/sessions/$id",
  component: SessionDetailPage,
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
    q: typeof search.q === "string" ? search.q : undefined,
    page: Number(search.page) > 1 ? Number(search.page) : undefined,
    cwd: typeof search.cwd === "string" ? search.cwd : undefined,
    model: typeof search.model === "string" ? search.model : undefined,
    hostname: typeof search.hostname === "string" ? search.hostname : undefined,
    source: typeof search.source === "string" ? search.source : undefined,
  }),
});

const routeTree = rootRoute.addChildren([listRoute, detailRoute, searchRoute]);

export const router = createRouter({ routeTree, basepath: "/app" });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

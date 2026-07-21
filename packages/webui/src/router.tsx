import { createRootRoute, createRoute, createRouter } from "@tanstack/react-router";
import { RootLayout } from "./routes/root";
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

const routeTree = rootRoute.addChildren([listRoute, detailRoute]);

export const router = createRouter({ routeTree, basepath: "/app" });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

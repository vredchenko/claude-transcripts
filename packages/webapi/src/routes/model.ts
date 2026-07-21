import { Hono } from "hono";
import type { AppContext } from "../context";

/**
 * Read-only introspection of the app model (central state) — serve the model over
 * the API, dynamically. Complements the compact `/` manifest with full facets.
 */
export function modelRoutes(ctx: AppContext) {
  const app = new Hono();

  // Full model, minus the heavy apiSpec (that's at /api/openapi.json).
  app.get("/model", (c) => {
    const { apiSpec: _apiSpec, ...rest } = ctx.model;
    return c.json(rest);
  });

  app.get("/model/services", (c) => c.json(ctx.model.services));
  app.get("/model/hooks", (c) => c.json(ctx.model.hooks));
  app.get("/model/actions", (c) =>
    c.json({ actions: ctx.model.actions, bindings: ctx.model.bindings }),
  );
  app.get("/model/env", (c) => c.json(ctx.model.env));

  return app;
}

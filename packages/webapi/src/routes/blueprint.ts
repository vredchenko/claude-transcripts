import { Hono } from "hono";
import type { AppContext } from "../context";

/**
 * Read-only introspection of the app model (central state) — serve the model over
 * the API, dynamically. Complements the compact `/` manifest with full facets.
 */
export function blueprintRoutes(ctx: AppContext) {
  const app = new Hono();

  // Full model, minus the heavy apiSpec (that's at /api/openapi.json).
  app.get("/model", (c) => {
    const { apiSpec: _apiSpec, ...rest } = ctx.blueprint;
    return c.json(rest);
  });

  app.get("/model/services", (c) => c.json(ctx.blueprint.services));
  app.get("/model/hooks", (c) => c.json(ctx.blueprint.hooks));
  app.get("/model/actions", (c) =>
    c.json({ actions: ctx.blueprint.actions, bindings: ctx.blueprint.bindings }),
  );
  app.get("/model/env", (c) => c.json(ctx.blueprint.env));

  return app;
}

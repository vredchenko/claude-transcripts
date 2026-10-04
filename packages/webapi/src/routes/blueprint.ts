import { Hono } from "hono";
import type { AppContext } from "../context";

/**
 * Read-only introspection of the blueprint (central state) — serve the blueprint over
 * the API, dynamically. Complements the compact `/` manifest with full facets.
 */
export function blueprintRoutes(ctx: AppContext) {
  const app = new Hono();

  // Full model, minus the heavy apiSpec (that's at /api/openapi.json).
  app.get("/blueprint", (c) => {
    const { apiSpec: _apiSpec, ...rest } = ctx.blueprint;
    return c.json(rest);
  });

  app.get("/blueprint/services", (c) => c.json(ctx.blueprint.services));
  app.get("/blueprint/hooks", (c) => c.json(ctx.blueprint.hooks));
  app.get("/blueprint/actions", (c) =>
    c.json({ actions: ctx.blueprint.actions, bindings: ctx.blueprint.bindings }),
  );
  app.get("/blueprint/env", (c) => c.json(ctx.blueprint.env));

  return app;
}

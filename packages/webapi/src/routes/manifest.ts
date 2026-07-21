import { toManifest } from "@claude-transcripts/shared";
import { Hono } from "hono";
import type { AppContext } from "../context";

/**
 * `/` — the machine-readable app manifest (agent entrypoint), NOT a UI page.
 * It's a projection of the in-memory app model (central state) — routes, config,
 * services, versions — so an agent/tool can bootstrap from one request. See
 * ADR 0022 + packages/shared/src/model.
 */
export function manifestRoutes(ctx: AppContext) {
  const app = new Hono();
  app.get("/", (c) => c.json(toManifest(ctx.model)));
  return app;
}

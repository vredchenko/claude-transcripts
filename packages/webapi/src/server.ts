import { OpenAPIHono } from "@hono/zod-openapi";
import { apiReference } from "@scalar/hono-api-reference";
import { serveStatic } from "hono/bun";
import type { AppContext } from "./context";
import { ingestRoutes } from "./routes/ingest";
import { manifestRoutes } from "./routes/manifest";
import { migrateRoutes } from "./routes/migrate";
import { modelRoutes } from "./routes/model";
import { proxyRoutes } from "./routes/proxy";
import { sessionRoutes } from "./routes/sessions";

export function buildServer(ctx: AppContext) {
  const app = new OpenAPIHono();

  app.get("/health", (c) =>
    c.json({ ok: true, status: "ok", version: ctx.model.identity.version }),
  );

  // App API (OpenAPI-typed) + curated ingest writes + read-only proxies + model
  // introspection, under /api.
  app.route("/api", sessionRoutes(ctx));
  app.route("/api", ingestRoutes(ctx));
  app.route("/api", proxyRoutes(ctx));
  app.route("/api", modelRoutes(ctx));
  app.route("/api", migrateRoutes(ctx));

  // OpenAPI spec (contract source of truth) + Scalar reference UI. Info is taken
  // from the model identity so it can't drift.
  const openapiConfig = {
    openapi: "3.0.0",
    info: { title: ctx.model.identity.title, version: ctx.model.identity.version },
  } as const;
  app.doc("/api/openapi.json", openapiConfig);
  app.get("/api/docs", apiReference({ spec: { url: "/api/openapi.json" } }));

  // `/` — machine-readable app manifest (agent entrypoint). Mount last so it
  // doesn't shadow /api or /app.
  app.route("/", manifestRoutes(ctx));

  // Serve the built webui SPA at /app in production (CT_STATIC_DIR set).
  const staticDir = ctx.config.webapi.staticDir;
  if (staticDir) {
    app.use(
      "/app/*",
      serveStatic({ root: staticDir, rewriteRequestPath: (p) => p.replace(/^\/app/, "") }),
    );
    app.get("/app", (c) => c.redirect("/app/"));
    app.get("/app/*", async () => {
      const index = Bun.file(`${staticDir}/index.html`);
      return new Response(await index.bytes(), { headers: { "content-type": "text/html" } });
    });
  }

  // Serve the prebuilt static docs at /docs in production (CT_DOCS_DIR set). The
  // docs are rendered from docs/*.md by scripts/build-docs.ts and baked into the
  // combined image (containers.md); the webui links here.
  const docsDir = ctx.config.webapi.docsDir;
  if (docsDir) {
    app.get("/docs", (c) => c.redirect("/docs/"));
    app.use(
      "/docs/*",
      serveStatic({
        root: docsDir,
        rewriteRequestPath: (p) => p.replace(/^\/docs\/?/, "/"),
      }),
    );
  }

  // Attach the generated OpenAPI document back onto the model (central state), so
  // the manifest + any consumer can see the live API contract in-memory.
  ctx.model.apiSpec = app.getOpenAPIDocument(openapiConfig);

  return app;
}

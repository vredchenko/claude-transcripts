import { OpenAPIHono } from "@hono/zod-openapi";
import { apiReference } from "@scalar/hono-api-reference";
import { serveStatic } from "hono/bun";
import { dbName } from "./config";
import type { AppContext } from "./context";
import { ingestRoutes } from "./routes/ingest";
import { manifestRoutes } from "./routes/manifest";
import { migrateRoutes } from "./routes/migrate";
import { modelRoutes } from "./routes/model";
import { proxyRoutes } from "./routes/proxy";
import { searchRoutes } from "./routes/search";
import { sessionRoutes } from "./routes/sessions";
import { couchFetch } from "./storage/couch";

/** Store status for `/health`: is the sessions database actually there, now? */
async function checkCouch(ctx: AppContext) {
  const database = dbName(ctx.config, "sessions");
  const base = {
    database,
    // Boot-time provisioning (databases + migrations) is separate from
    // reachability: CouchDB may have come up after we did.
    provisioned: ctx.boot.couchProvisioned,
    ...(ctx.boot.error ? { provisioningError: ctx.boot.error } : {}),
  };
  try {
    const res = await couchFetch(ctx.couch.url, `/${encodeURIComponent(database)}`, {
      method: "HEAD",
      signal: AbortSignal.timeout(2000),
    });
    if (res.ok) return { ok: true, ...base };
    const why =
      res.status === 404
        ? `database "${database}" does not exist`
        : res.status === 401
          ? "CouchDB rejected the credentials"
          : `CouchDB returned ${res.status}`;
    return { ok: false, ...base, error: why };
  } catch (err) {
    // Never surface ctx.couch.url — it carries credentials.
    return { ok: false, ...base, error: `CouchDB unreachable: ${(err as Error).message}` };
  }
}

export function buildServer(ctx: AppContext) {
  const app = new OpenAPIHono();

  // Surface the cause of a failure instead of a bare "Internal Server Error".
  // Tier 1 is a single user on localhost, so the message is safe to return —
  // and without it a store-level failure (missing database, unreachable
  // CouchDB/S3) reaches the CLI as an opaque 500 that needs server logs to read.
  app.onError((err, c) => {
    const status = (err as { statusCode?: number }).statusCode;
    const reason = (err as { reason?: string }).reason;
    const message = [err.message, reason].filter(Boolean).join(" — ");
    console.error(`[webapi] ${c.req.method} ${c.req.path} failed:`, err);
    return c.json(
      { error: message || "Internal Server Error", ...(status ? { upstreamStatus: status } : {}) },
      500,
    );
  });

  /**
   * Liveness + store readiness.
   *
   * Always HTTP 200 while the process is alive — "can I reach the webapi" and
   * "are its stores usable" are different questions, and callers (tests, the
   * CLI, container probes) rely on the first. The body answers the second:
   * `ok: false` / `status: "degraded"` when the sessions database can't be
   * reached, with the reason. Without this, a webapi whose provisioning failed
   * reports "ok" and only reveals the truth as a 500 on the first write.
   */
  app.get("/health", async (c) => {
    const couch = await checkCouch(ctx);
    return c.json({
      ok: couch.ok,
      status: couch.ok ? "ok" : "degraded",
      version: ctx.model.identity.version,
      startedAt: ctx.boot.startedAt,
      stores: { couch },
    });
  });

  // App API (OpenAPI-typed) + curated ingest writes + read-only proxies + model
  // introspection, under /api.
  app.route("/api", sessionRoutes(ctx));
  app.route("/api", ingestRoutes(ctx));
  app.route("/api", searchRoutes(ctx));
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

  // Stream the bundled CLI binary for download (CT_CLI_BIN set, i.e. the combined
  // image). The webui's "Download CLI" link points here.
  const cliBin = ctx.config.webapi.cliBin;
  if (cliBin) {
    app.get("/cli/download", async (c) => {
      const file = Bun.file(cliBin);
      if (!(await file.exists())) return c.json({ error: "CLI binary not available" }, 404);
      return new Response(await file.bytes(), {
        headers: {
          "content-type": "application/octet-stream",
          "content-disposition": 'attachment; filename="claude-transcripts"',
        },
      });
    });
  }

  // Attach the generated OpenAPI document back onto the model (central state), so
  // the manifest + any consumer can see the live API contract in-memory.
  ctx.model.apiSpec = app.getOpenAPIDocument(openapiConfig);

  return app;
}

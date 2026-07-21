import { Hono } from "hono";
import { bucketName } from "../config";
import type { AppContext } from "../context";

/**
 * Read-only transparent proxies — CouchDB's HTTP API and S3 object reads are
 * themselves a useful surface (docs + design views, blobs). Per ADR 0016, only
 * **reads** are proxied; writes always go through curated webapi endpoints.
 */
export function proxyRoutes(ctx: AppContext) {
  const app = new Hono();

  const readOnly = (method: string) => method === "GET" || method === "HEAD";

  // /api/couch/* → CouchDB HTTP API (GET/HEAD only)
  app.all("/couch/*", async (c) => {
    if (!readOnly(c.req.method)) {
      return c.json({ error: "Read-only proxy: writes go through /api endpoints" }, 405);
    }
    const path = c.req.path.replace(/^\/api\/couch/, "");
    const target = `${ctx.couch.url}${path}${new URL(c.req.url).search}`;
    const res = await fetch(target, {
      method: c.req.method,
      headers: { accept: "application/json" },
    });
    return new Response(res.body, { status: res.status, headers: res.headers });
  });

  // /api/s3/<bucketKey>/<objectKey...> → object reads (GET/HEAD only)
  app.all("/s3/:bucketKey/*", async (c) => {
    if (!readOnly(c.req.method)) {
      return c.json({ error: "Read-only proxy: writes go through /api endpoints" }, 405);
    }
    const bucketKey = c.req.param("bucketKey");
    const key = c.req.path.replace(new RegExp(`^/api/s3/${bucketKey}/`), "");
    let bucket: string;
    try {
      bucket = bucketName(ctx.config, bucketKey);
    } catch {
      return c.json({ error: `Unknown bucket key: ${bucketKey}` }, 404);
    }
    const stat = await ctx.blob.stat(bucket, key);
    if (!stat) return c.json({ error: "Not found" }, 404);
    if (c.req.method === "HEAD") {
      return new Response(null, {
        headers: {
          "content-length": String(stat.size),
          "content-type": stat.contentType ?? "application/octet-stream",
        },
      });
    }
    const stream = await ctx.blob.get(bucket, key);
    return new Response(stream, {
      headers: { "content-type": stat.contentType ?? "application/octet-stream" },
    });
  });

  return app;
}

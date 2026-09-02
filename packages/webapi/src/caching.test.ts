import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { serveStatic } from "hono/bun";
import { etag } from "hono/etag";
import { cacheControlFor, compression, isSpaAssetPath } from "./caching";

const HASHED = "index-DKnR0ZmO.js";
/** Comfortably over the 1 KB threshold, and compressible enough to prove the point. */
const BUNDLE = `console.log(${JSON.stringify("x".repeat(4000))});\n`;
const SHELL = `<!doctype html><title>t</title><p>${"shell ".repeat(400)}</p>`;
const BINARY = new Uint8Array(4096).fill(7);

let dir: string;
let app: Hono;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "ct-caching-"));
  await mkdir(join(dir, "assets"), { recursive: true });
  await writeFile(join(dir, "assets", HASHED), BUNDLE);
  await writeFile(join(dir, "index.html"), SHELL);
  await writeFile(join(dir, "blob.bin"), BINARY);

  // Mirrors how `server.ts` wires these together: compression outermost, an ETag
  // only where a client will revalidate, cache policy from the static mount.
  app = new Hono();
  app.use("*", compression());
  app.get("/api/small", (c) => c.json({ ok: true }));
  app.get("/api/couch/db/_changes", (c) => c.json({ results: BUNDLE }));
  const shellEtag = etag();
  app.use("/app/*", async (c, next) => (isSpaAssetPath(c.req.path) ? next() : shellEtag(c, next)));
  app.use(
    "/app/*",
    serveStatic({
      root: dir,
      rewriteRequestPath: (p) => p.replace(/^\/app/, ""),
      onFound: (path, c) => c.header("Cache-Control", cacheControlFor("spa", path)),
    }),
  );
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** Drives the app in-process, so nothing decompresses the body behind our back. */
async function get(path: string, headers: Record<string, string> = {}): Promise<Response> {
  return await app.fetch(new Request(`http://localhost${path}`, { headers }));
}

const GZIP = { "accept-encoding": "gzip, deflate, br" };

describe("cacheControlFor", () => {
  test("a hashed SPA asset is immutable for a year", () => {
    expect(cacheControlFor("spa", `/build/assets/${HASHED}`)).toBe(
      "public, max-age=31536000, immutable",
    );
  });

  test("the SPA shell always revalidates", () => {
    expect(cacheControlFor("spa", "/build/index.html")).toBe("no-cache");
  });

  test("the docs tree revalidates even under assets/ — it is never hashed", () => {
    expect(cacheControlFor("docs", "/docs-dist/assets/architecture.svg")).toBe("no-cache");
    expect(cacheControlFor("docs", "/docs-dist/design/architecture.html")).toBe("no-cache");
  });

  test("isSpaAssetPath matches the request path as well as the file path", () => {
    expect(isSpaAssetPath(`/app/assets/${HASHED}`)).toBe(true);
    expect(isSpaAssetPath("/app/index.html")).toBe(false);
  });
});

/**
 * hono's `compress()` needs `CompressionStream`, which Bun did not provide before
 * 1.3.3. `engines.bun` declares that floor and CI tests at it, so the encoding tests
 * below always run where it matters — but a contributor on an older Bun should see the
 * degraded behaviour verified rather than a red suite they cannot fix.
 */
const CAN_COMPRESS = typeof globalThis.CompressionStream === "function";

describe("compression", () => {
  test.skipIf(!CAN_COMPRESS)(
    "compresses a large asset and declares that it varies by encoding",
    async () => {
      const res = await get(`/app/assets/${HASHED}`, GZIP);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-encoding")).toBe("gzip");
      expect(res.headers.get("vary")?.toLowerCase()).toContain("accept-encoding");

      const body = new Uint8Array(await res.arrayBuffer());
      expect(body.byteLength).toBeLessThan(BUNDLE.length);
      expect(new TextDecoder().decode(Bun.gunzipSync(body))).toBe(BUNDLE);
    },
  );

  test.skipIf(CAN_COMPRESS)(
    "without CompressionStream, serves the body uncompressed instead of failing",
    async () => {
      // The failure this replaces was a 500 on every compressible response, thrown
      // inside hono, with a stack naming hono rather than the runtime.
      const res = await get(`/app/assets/${HASHED}`, GZIP);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-encoding")).toBeNull();
      expect(await res.text()).toBe(BUNDLE);
      // Still advertised, so a cache filled here stays correct if this deployment is
      // later restarted on a runtime that can encode.
      expect(res.headers.get("vary")?.toLowerCase()).toContain("accept-encoding");
    },
  );

  test("leaves the body alone when the client asks for no encoding", async () => {
    const res = await get(`/app/assets/${HASHED}`);
    expect(res.headers.get("content-encoding")).toBeNull();
    expect(await res.text()).toBe(BUNDLE);
    // Still advertised, so a shared cache keys on it either way.
    expect(res.headers.get("vary")?.toLowerCase()).toContain("accept-encoding");
  });

  test("a small response is not encoded, and keeps a real Content-Length", async () => {
    const res = await get("/api/small", GZIP);
    expect(res.headers.get("content-encoding")).toBeNull();
    const body = await res.text();
    expect(body).toBe(JSON.stringify({ ok: true }));
    // The regression this guards: hono's own threshold is inert on Bun, because
    // responses arrive without a Content-Length to test — so tiny bodies were being
    // gzipped into something *larger*, and chunked.
    expect(res.headers.get("content-length")).toBe(String(Buffer.byteLength(body)));
  });

  test("never touches a binary body", async () => {
    const res = await get("/app/blob.bin", GZIP);
    expect(res.headers.get("content-type")).toBe("application/octet-stream");
    expect(res.headers.get("content-encoding")).toBeNull();
    expect(res.headers.get("vary")).toBeNull();
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(BINARY);
  });

  test("never touches a CouchDB change feed — compressing one stalls it", async () => {
    const res = await get("/api/couch/db/_changes?feed=continuous", GZIP);
    expect(res.headers.get("content-encoding")).toBeNull();
  });
});

describe("cache headers", () => {
  test("a hashed asset is served immutable", async () => {
    const res = await get(`/app/assets/${HASHED}`, GZIP);
    expect(res.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
  });

  test("the shell revalidates, and its ETag turns that into a 304", async () => {
    const first = await get("/app/index.html", GZIP);
    expect(first.headers.get("cache-control")).toBe("no-cache");
    const tag = first.headers.get("etag");
    expect(tag).toBeTruthy();

    const second = await get("/app/index.html", { ...GZIP, "if-none-match": tag as string });
    expect(second.status).toBe(304);
    expect(second.headers.get("cache-control")).toBe("no-cache");
    expect(second.headers.get("etag")).toBeTruthy();
  });

  test("hashed assets get no ETag — they are immutable, so nothing would use it", async () => {
    const res = await get(`/app/assets/${HASHED}`, GZIP);
    expect(res.headers.get("etag")).toBeNull();
  });
});

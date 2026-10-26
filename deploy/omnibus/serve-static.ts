#!/usr/bin/env bun
/**
 * A minimal static file server for single-page apps: serves `root`, and answers any
 * path that isn't a file with `index.html`. The omnibus uses it for the Meilisearch UI,
 * whose upstream image would otherwise run a vite build on every start.
 *
 *   bun run serve-static.ts <root> <port> [hostname]
 */
import { join, normalize } from "node:path";

const [root, port, hostname = "0.0.0.0"] = process.argv.slice(2);
if (!root || !port) {
  console.error("usage: serve-static.ts <root> <port> [hostname]");
  process.exit(2);
}

Bun.serve({
  hostname,
  port: Number(port),
  async fetch(req) {
    // normalize() resolves `..` against "/", so a request can't climb out of root.
    const path = normalize(decodeURIComponent(new URL(req.url).pathname));
    const file = Bun.file(join(root, path));
    if (path !== "/" && (await file.exists())) return new Response(file);
    return new Response(Bun.file(join(root, "index.html")), {
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  },
});
console.log(`[serve-static] ${root} on http://${hostname}:${port}`);

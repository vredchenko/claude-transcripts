import { Hono } from "hono";
import { bucketName, repositoryName } from "../config";
import type { AppContext } from "../context";
import { couchFetch } from "../storage/couch";

/**
 * Fossil JSON API commands that only read. Keyed by command; the value lists the
 * subcommands allowed (`null` = any, every subcommand reads).
 *
 * An allowlist rather than a pass-through because Fossil's JSON API takes its
 * parameters from the query string, so a plain GET can write: `/json/user/save?name=…
 * &capabilities=s` grants a user setup rights. Read-only by method is therefore not
 * read-only here, and ADR 0016 says writes are never proxied.
 */
export const FOSSIL_READ_COMMANDS: Record<string, readonly string[] | null> = {
  version: null,
  stat: null,
  whoami: null,
  cap: null,
  resultCodes: null,
  timeline: null,
  artifact: null,
  dir: null,
  finfo: null,
  diff: null,
  branch: ["list"],
  tag: ["list", "find"],
  wiki: ["list", "get", "diff"],
  report: ["list", "get", "run"],
};

/**
 * Query parameters refused outright. `command` re-dispatches a bare `/json` request to
 * any command, around the allowlist; `jsonp` wraps the answer in a caller-named
 * function, which would serve attacker-chosen script from this origin. Compared
 * case-insensitively: Fossil lowercases a parameter name that starts upper-case
 * (cgi.c), so `JSONP=` reaches it as `jsonp`.
 */
const FOSSIL_REFUSED_PARAMS = ["command", "jsonp"];

/**
 * Map a request under `/api/fossil/<repoKey>/` to the Fossil URL path it may read, or
 * explain why not. `rest` is everything after the repo key, e.g. `json/timeline/checkin`.
 * The path is rebuilt from vetted, re-encoded segments — never passed through — so no
 * `..` or encoded slash can reach a command the allowlist didn't name.
 */
export function fossilJsonPath(
  rest: string,
  search: URLSearchParams,
): { path: string } | { error: string } {
  const segments = rest.split("/").filter((s) => s !== "");
  if (segments[0] !== "json") return { error: "Only Fossil's JSON API is proxied (/json/...)" };
  const [command, sub] = [segments[1], segments[2]];
  if (!command) return { error: "Name a JSON API command, e.g. /json/timeline" };
  if (segments.some((s) => s === "." || s === "..")) return { error: "Bad path" };
  if (!Object.hasOwn(FOSSIL_READ_COMMANDS, command)) {
    return { error: `Not a read-only command: ${command}` };
  }
  const subs = FOSSIL_READ_COMMANDS[command];
  if (subs && (!sub || !subs.includes(sub))) {
    return { error: `Read-only subcommands of ${command}: ${subs.join(", ")}` };
  }
  const names = [...search.keys()].map((k) => k.toLowerCase());
  const refused = FOSSIL_REFUSED_PARAMS.find((p) => names.includes(p));
  if (refused) return { error: `Query parameter not allowed: ${refused}` };
  return { path: `/${segments.map(encodeURIComponent).join("/")}` };
}

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
    // `couchFetch` moves the URL's credentials into a header — `fetch` won't send
    // userinfo, so passing ctx.couch.url straight through proxies an ANONYMOUS
    // request and any authenticated CouchDB answers 401.
    const res = await couchFetch(ctx.couch.url, `${path}${new URL(c.req.url).search}`, {
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

  // /api/fossil/<repoKey>/json/<command>... → Fossil's JSON API (GET/HEAD, read-only
  // commands only — see FOSSIL_READ_COMMANDS). Anonymous: no client header is forwarded,
  // so a cookie can't smuggle in parameters or a login (Fossil reads both from cookies).
  app.all("/fossil/:repoKey/*", async (c) => {
    if (!readOnly(c.req.method)) {
      return c.json({ error: "Read-only proxy: writes go through /api endpoints" }, 405);
    }
    const repoKey = c.req.param("repoKey");
    let repo: string;
    try {
      repo = repositoryName(ctx.config, repoKey);
    } catch {
      return c.json({ error: `Unknown repository key: ${repoKey}` }, 404);
    }
    const url = new URL(c.req.url);
    const rest = c.req.path.slice(`/api/fossil/${repoKey}`.length);
    const target = fossilJsonPath(rest, url.searchParams);
    if ("error" in target) return c.json({ error: target.error }, 403);
    let res: Response;
    try {
      res = await fetch(
        `${ctx.config.fossil.url}/${encodeURIComponent(repo)}${target.path}${url.search}`,
        {
          method: c.req.method,
          headers: { accept: "application/json" },
          redirect: "manual",
        },
      );
    } catch {
      return c.json({ error: "Fossil is unreachable" }, 502);
    }
    // Always JSON, never sniffed: an HTML error page from Fossil must not render as a
    // page of this origin.
    return new Response(res.body, {
      status: res.status,
      headers: { "content-type": "application/json", "x-content-type-options": "nosniff" },
    });
  });

  return app;
}

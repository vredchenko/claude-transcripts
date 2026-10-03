/**
 * The Fossil proxy must stay read-only even though Fossil's JSON API isn't: its
 * parameters come from the query string, so a GET can write (`/json/user/save?...`
 * grants setup rights), and a bare `/json?command=...` dispatches to any command.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import type { AppContext } from "../context";
import { fossilJsonPath, proxyRoutes } from "./proxy";

const q = (s = "") => new URLSearchParams(s);

describe("fossilJsonPath", () => {
  test("read-only commands pass, rebuilt from their segments", () => {
    expect(fossilJsonPath("json/version", q())).toEqual({ path: "/json/version" });
    expect(fossilJsonPath("json/timeline/checkin", q("limit=5"))).toEqual({
      path: "/json/timeline/checkin",
    });
    expect(fossilJsonPath("json/wiki/get/Home", q())).toEqual({ path: "/json/wiki/get/Home" });
  });

  test("writing commands and subcommands are refused", () => {
    for (const rest of [
      "json/user/save",
      "json/query",
      "json/config/save",
      "json/wiki/create",
      "json/wiki/save",
      "json/tag/add",
      "json/branch/create",
      "json/login",
    ]) {
      expect(fossilJsonPath(rest, q())).toHaveProperty("error");
    }
  });

  test("a bare /json, which dispatches on ?command=, is refused", () => {
    expect(fossilJsonPath("json", q("command=user/save"))).toHaveProperty("error");
    expect(fossilJsonPath("json/version", q("command=user/save"))).toHaveProperty("error");
  });

  test("dot segments can't climb out of an allowed command", () => {
    expect(fossilJsonPath("json/timeline/../user/save", q())).toHaveProperty("error");
    expect(fossilJsonPath("json/./user/save", q())).toHaveProperty("error");
  });

  test("JSONP is refused, and nothing outside /json is proxied", () => {
    expect(fossilJsonPath("json/version", q("jsonp=alert"))).toHaveProperty("error");
    expect(fossilJsonPath("setup_ulist", q())).toHaveProperty("error");
    expect(fossilJsonPath("raw/abc", q())).toHaveProperty("error");
  });

  test("an inherited object key is not a command", () => {
    expect(fossilJsonPath("json/constructor", q())).toHaveProperty("error");
    expect(fossilJsonPath("json/__proto__", q())).toHaveProperty("error");
  });
});

describe("/api/fossil route", () => {
  const seen: { path: string; method: string; cookie: string | null }[] = [];
  const upstream = Bun.serve({
    port: 0,
    fetch(req) {
      const u = new URL(req.url);
      seen.push({
        path: u.pathname + u.search,
        method: req.method,
        cookie: req.headers.get("cookie"),
      });
      return Response.json({ ok: true });
    },
  });
  afterAll(() => upstream.stop(true));

  const ctx = {
    config: {
      fossil: {
        url: `http://127.0.0.1:${upstream.port}`,
        repositories: { sessions: "claude-transcripts-sessions" },
      },
      s3: { buckets: {} },
    },
  } as unknown as AppContext;
  // Mounted as server.ts mounts it: the handlers strip the `/api` prefix themselves.
  const app = new Hono().route("/api", proxyRoutes(ctx));
  const call = (path: string, init?: RequestInit) =>
    app.request(`http://localhost/api${path}`, init);

  test("forwards a read to the repository named by the key, without client headers", async () => {
    const res = await call("/fossil/sessions/json/timeline/checkin?limit=5", {
      headers: { cookie: "fossil-abc=login" },
    });
    expect(res.status).toBe(200);
    expect(seen.at(-1)).toEqual({
      path: "/claude-transcripts-sessions/json/timeline/checkin?limit=5",
      method: "GET",
      cookie: null,
    });
  });

  test("refuses writes before they reach Fossil", async () => {
    const before = seen.length;
    expect((await call("/fossil/sessions/json/user/save?name=x&capabilities=s")).status).toBe(403);
    expect((await call("/fossil/sessions/json?command=user/save")).status).toBe(403);
    expect((await call("/fossil/sessions/json/version", { method: "POST" })).status).toBe(405);
    expect(seen.length).toBe(before);
  });

  test("an unknown repository key is a 404", async () => {
    expect((await call("/fossil/nope/json/version")).status).toBe(404);
  });

  test("an unreachable Fossil is a 502, not a crash", async () => {
    const down = new Hono().route(
      "/api",
      proxyRoutes({
        config: { fossil: { url: "http://127.0.0.1:1", repositories: { sessions: "r" } } },
      } as unknown as AppContext),
    );
    const res = await down.request("http://localhost/api/fossil/sessions/json/version");
    expect(res.status).toBe(502);
  });
});

/**
 * `/api/blueprint` is a plain Hono route, outside the OpenAPI contract, so
 * `check:contract` can't see it move. These pin where it lives (#142).
 */
import { describe, expect, test } from "bun:test";
import { type AppConfigFile, buildAppBlueprint } from "@claude-transcripts/shared";
import { Hono } from "hono";
import type { AppContext } from "../context";
import { blueprintRoutes } from "./blueprint";

const CONFIG: AppConfigFile = {
  system: { logging: { chunk: { maxEntriesPerChunk: 200, flushIntervalMs: 15000 } } },
  couchdb: { databases: { sessions: "ct-sessions" } },
  s3: { buckets: { sessions: "ct-blobs" } },
  features: {},
  servicesMenu: {},
};

const blueprint = buildAppBlueprint(CONFIG, {});
blueprint.apiSpec = { openapi: "3.1.0", info: { title: "t", version: "0" }, paths: {} };
const app = new Hono().route("/api", blueprintRoutes({ blueprint } as unknown as AppContext));

describe("blueprintRoutes", () => {
  test("serves the blueprint at /api/blueprint, without the heavy apiSpec", async () => {
    const res = await app.request("/api/blueprint");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.identity).toEqual(blueprint.identity);
    expect(body).not.toHaveProperty("apiSpec");
  });

  test("serves each facet under it", async () => {
    for (const facet of ["services", "hooks", "actions", "env"]) {
      expect((await app.request(`/api/blueprint/${facet}`)).status).toBe(200);
    }
  });

  test("the old /api/model path is gone, not aliased", async () => {
    expect((await app.request("/api/model")).status).toBe(404);
  });
});

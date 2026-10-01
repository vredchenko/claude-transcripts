/**
 * The hook's runtime config file.
 *
 * Everything in it is a projection of `config/` + `.env` and so is safe to rewrite —
 * except `mirrors`, which is the machine's own and exists nowhere else. These pin that
 * a rewrite keeps it, because losing it stops mirroring silently: the hook swallows
 * every failure by design, so nothing would report the loss.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildHookConfig, mergePreserved, writeHookConfig } from "./hook-config";

let dir: string;
let path: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ct-hook-config-"));
  path = join(dir, "config.json");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const MIRRORS = [{ url: "https://logs.example.com", timeoutMs: 2000 }];

function read(): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf8"));
}

describe("writeHookConfig", () => {
  test("carries mirrors across a regeneration that knows nothing about them", () => {
    writeFileSync(path, JSON.stringify({ couch: { url: "http://old" }, mirrors: MIRRORS }));

    // What `setup` / `install` rebuild from config + env: no mirrors key at all.
    writeHookConfig(path, { couch: { url: "http://new" }, features: { s3Blobs: true } });

    const out = read();
    expect(out.mirrors).toEqual(MIRRORS);
    expect((out.couch as { url: string }).url).toBe("http://new");
  });

  test("writes a config with no mirrors when the machine never had any", () => {
    writeHookConfig(path, { couch: { url: "http://new" } });
    expect(read().mirrors).toBeUndefined();
  });

  test("an explicit value wins, so a caller can still set or clear mirrors", () => {
    writeFileSync(path, JSON.stringify({ mirrors: MIRRORS }));
    writeHookConfig(path, { couch: { url: "http://new" }, mirrors: [] });
    expect(read().mirrors).toEqual([]);
  });

  test("an unparseable existing file does not block a rewrite", () => {
    writeFileSync(path, "{ not json");
    writeHookConfig(path, { couch: { url: "http://new" } });
    expect((read().couch as { url: string }).url).toBe("http://new");
  });

  test("stays 0600 — it holds store credentials", () => {
    writeHookConfig(path, { couch: { url: "http://new" } });
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });
});

describe("mergePreserved", () => {
  test("a hand-set webapi survives a regeneration whose env names none", () => {
    const webapi = { url: "https://logs.example.com" };
    expect(mergePreserved({ couch: { url: "new" } }, { webapi }).webapi).toEqual(webapi);
  });

  test("a projected webapi replaces the old one", () => {
    const merged = mergePreserved(
      { webapi: { url: "http://127.0.0.1:7658" } },
      { webapi: { url: "https://logs.example.com" } },
    );
    expect(merged.webapi).toEqual({ url: "http://127.0.0.1:7658" });
  });

  test("only preserved keys survive; the rest of the old file is discarded", () => {
    const merged = mergePreserved(
      { couch: { url: "new" } },
      { couch: { url: "old" }, features: { gone: true }, mirrors: MIRRORS },
    );
    expect(merged).toEqual({ couch: { url: "new" }, mirrors: MIRRORS });
  });
});

describe("buildHookConfig", () => {
  const app = {
    system: { logging: { chunk: { maxEntriesPerChunk: 50, flushIntervalMs: 1000 } } },
    couchdb: { databases: { sessions: "sessions" } },
    s3: { buckets: { blobs: "blobs" } },
    features: {},
    servicesMenu: {},
    recall: { mode: "suggest" as const, scope: "host" as const, maxResults: 3 },
  };

  test("carries the recall policy, and omits it when the config has none", () => {
    expect(buildHookConfig(app, {}).recall).toEqual(app.recall);
    const { recall: _, ...bare } = app;
    expect("recall" in buildHookConfig(bare, {})).toBe(false);
  });

  test("an empty env yields the bundled Couch URL, no auth and no blob store", () => {
    const out = buildHookConfig(app, {});
    expect(out.couch.url).toBe("http://127.0.0.1:7652");
    expect(out.couch.auth).toBeUndefined();
    expect(out.blob).toBeUndefined();
  });

  test("names the webapi when the env does, and omits it when not", () => {
    // `install` passes the instance env, which always carries the port it generated.
    expect(buildHookConfig(app, { WEBAPI_HOST: "127.0.0.1", WEBAPI_PORT: "7658" }).webapi).toEqual({
      url: "http://127.0.0.1:7658",
    });
    expect(buildHookConfig(app, { WEBAPI_HOST: "0.0.0.0", WEBAPI_PORT: "7658" }).webapi).toEqual({
      url: "http://127.0.0.1:7658",
    });
    expect(
      buildHookConfig(app, { CT_WEBAPI_URL: "https://logs.example.com/", WEBAPI_PORT: "7650" })
        .webapi,
    ).toEqual({ url: "https://logs.example.com" });
    expect("webapi" in buildHookConfig(app, { WEBAPI_HOST: "127.0.0.1" })).toBe(false);
  });

  test("an empty S3_REGION falls back to the default", () => {
    const env = { S3_ENDPOINT: "http://127.0.0.1:7653", S3_REGION: "" };
    expect(buildHookConfig(app, env).blob?.region).toBe("garage");
  });
});

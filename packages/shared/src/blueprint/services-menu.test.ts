/**
 * The services menu: a configured link wins; an unset key falls back to a link derived
 * from the service's resolved host port, so the bundled stack works with no config and
 * follows a per-instance port block.
 */
import { describe, expect, test } from "bun:test";
import { buildAppBlueprint } from "./build";
import { SERVICES } from "./services";
import type { AppConfigFile } from "./types";

const CONFIG: AppConfigFile = {
  system: { logging: { chunk: { maxEntriesPerChunk: 200, flushIntervalMs: 15000 } } },
  couchdb: { databases: { sessions: "s" } },
  s3: { buckets: { sessions: "s" } },
  features: {},
  servicesMenu: {},
};

describe("servicesMenu — derived fallback", () => {
  test("unset keys follow the env's ports", () => {
    const model = buildAppBlueprint(CONFIG, {
      COUCHDB_PORT: "7660",
      MEILI_PORT: "7664",
      MEILI_UI_PORT: "7665",
      GARAGE_WEBUI_PORT: "7663",
      FOSSIL_PORT: "7666",
    });
    expect(model.servicesMenu.couchdbFauxton).toBe("http://127.0.0.1:7660/_utils/");
    expect(model.servicesMenu.meilisearch).toBe("http://127.0.0.1:7664/");
    expect(model.servicesMenu.meilisearchUi).toBe("http://127.0.0.1:7665/");
    expect(model.servicesMenu.garageWebui).toBe("http://127.0.0.1:7663/");
    expect(model.servicesMenu.fossil).toBe("http://127.0.0.1:7666/");
  });
});

describe("servicesMenu — config wins where it speaks", () => {
  test("a configured link overrides the derived one", () => {
    const model = buildAppBlueprint(
      { ...CONFIG, servicesMenu: { couchdbFauxton: "https://couch.example/_utils/" } },
      { COUCHDB_PORT: "7660" },
    );
    expect(model.servicesMenu.couchdbFauxton).toBe("https://couch.example/_utils/");
  });

  test("keys the config leaves unset still fall back to derived", () => {
    const model = buildAppBlueprint(
      { ...CONFIG, servicesMenu: { couchdbFauxton: "https://couch.example/_utils/" } },
      { GARAGE_WEBUI_PORT: "7663" },
    );
    expect(model.servicesMenu.garageWebui).toBe("http://127.0.0.1:7663/");
  });

  test("a link copied from an old template doesn't override the instance's ports", () => {
    const model = buildAppBlueprint(
      {
        ...CONFIG,
        servicesMenu: {
          couchdbFauxton: "http://127.0.0.1:7652/_utils/",
          garageWebui: "http://127.0.0.1:7655/",
          meilisearch: "http://127.0.0.1:7656/",
        },
      },
      { COUCHDB_PORT: "7660", GARAGE_WEBUI_PORT: "7663", MEILI_PORT: "7664" },
    );
    expect(model.servicesMenu.couchdbFauxton).toBe("http://127.0.0.1:7660/_utils/");
    expect(model.servicesMenu.garageWebui).toBe("http://127.0.0.1:7663/");
    expect(model.servicesMenu.meilisearch).toBe("http://127.0.0.1:7664/");
  });
});

/**
 * The menu is rendered by a browser on the **host**, but the blueprint that builds it runs
 * inside the app container. Any service whose host-port env var the app container
 * overrides therefore yields a link to a container-internal port — which is exactly
 * what happened to CouchDB: compose pinned `COUCHDB_PORT=5984`, and the menu offered
 * `127.0.0.1:5984`, where nothing on the host listens.
 */
describe("servicesMenu — container/host port confusion", () => {
  test("the app container overrides no host-port var a menu link depends on", () => {
    const app = SERVICES.find((s) => s.key === "app");
    expect(app).toBeDefined();
    const overridden = new Set(Object.keys(app?.containerEnv ?? {}));
    const needed = SERVICES.filter((s) => s.adminUiServiceKey).flatMap((s) =>
      (s.ports ?? []).map((p) => p.hostEnv),
    );
    expect(needed.filter((v) => overridden.has(v))).toEqual([]);
  });
});

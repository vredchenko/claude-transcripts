/**
 * The services menu must follow a deployment's real ports.
 *
 * These links used to be literal URLs in `config/` carrying the template's defaults,
 * so on any instance whose port block `install` generated differently — most of them —
 * every link pointed at a closed port while sitting in the instance's own config file,
 * looking authoritative.
 */
import { describe, expect, test } from "bun:test";
import { buildAppModel } from "./build";
import type { AppConfigFile } from "./types";

const CONFIG: AppConfigFile = {
  system: { logging: { chunk: { maxEntriesPerChunk: 200, flushIntervalMs: 15000 } } },
  couchdb: { databases: { sessions: "s" } },
  s3: { buckets: { sessions: "s" } },
  features: {},
  // Deliberately stale — the shape an instance installed before this fix still has.
  servicesMenu: {
    couchdbFauxton: "http://127.0.0.1:7652/_utils/",
    meilisearch: "http://127.0.0.1:7656/",
  },
};

describe("servicesMenu", () => {
  test("follows the env's ports, not the config's stale defaults", () => {
    const model = buildAppModel(CONFIG, {
      COUCHDB_PORT: "7660",
      MEILI_PORT: "7664",
      MEILI_UI_PORT: "7665",
      GARAGE_WEBUI_PORT: "7663",
    });
    expect(model.servicesMenu.couchdbFauxton).toBe("http://127.0.0.1:7660/_utils/");
    expect(model.servicesMenu.meilisearch).toBe("http://127.0.0.1:7664/");
    expect(model.servicesMenu.meilisearchUi).toBe("http://127.0.0.1:7665/");
    expect(model.servicesMenu.garageWebui).toBe("http://127.0.0.1:7663/");
  });

  test("falls back to each service's default port when env says nothing", () => {
    const model = buildAppModel(CONFIG, {});
    expect(model.servicesMenu.couchdbFauxton).toBe("http://127.0.0.1:7652/_utils/");
  });

  test("keeps CouchDB's Fauxton path rather than linking the bare root", () => {
    const model = buildAppModel(CONFIG, { COUCHDB_PORT: "7660" });
    expect(model.servicesMenu.couchdbFauxton).toEndWith("/_utils/");
  });

  test("carries through config keys the model doesn't know", () => {
    const model = buildAppModel(
      { ...CONFIG, servicesMenu: { ...CONFIG.servicesMenu, myDashboard: "https://ops.example" } },
      { COUCHDB_PORT: "7660" },
    );
    // An operator's own link survives…
    expect(model.servicesMenu.myDashboard).toBe("https://ops.example");
    // …without letting their stale copy of a known key win.
    expect(model.servicesMenu.couchdbFauxton).toBe("http://127.0.0.1:7660/_utils/");
  });
});

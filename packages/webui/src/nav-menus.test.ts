/**
 * The header menus are projections of the app model: these run them over a model
 * built the way the webapi builds the one it serves, so a change to services,
 * topology, stores or routes shows up here rather than as a silently emptier menu.
 */
import { describe, expect, test } from "bun:test";
import { type AppConfigFile, buildAppBlueprint } from "@claude-transcripts/shared";
import type { AppBlueprintInfo } from "./api/blueprint";
import { aboutLinks, devMenuSections, servicesMenuGroups, sessionLinks } from "./nav-menus";

const CONFIG: AppConfigFile = {
  system: { logging: { chunk: { maxEntriesPerChunk: 200, flushIntervalMs: 15000 } } },
  couchdb: { databases: { sessions: "ct-sessions", appLogs: "ct-logs" } },
  s3: { buckets: { sessions: "ct-blobs" } },
  meilisearch: { indexes: { sessions: "ct-search" } },
  fossil: { repositories: { sessions: "ct-repo" } },
  features: {},
  servicesMenu: {},
};

/** Round-tripped through JSON, as the webui receives it from `GET /api/model`. */
function served(config: AppConfigFile = CONFIG): AppBlueprintInfo {
  return JSON.parse(JSON.stringify(buildAppBlueprint(config))) as AppBlueprintInfo;
}

describe("servicesMenuGroups", () => {
  test("one group per store, in topology order, each with its icon", () => {
    const groups = servicesMenuGroups(served());
    expect(groups.map((g) => [g.key, g.label, g.icon])).toEqual([
      ["couchdb", "CouchDB", "couchdb"],
      ["garage", "Garage", "garage"],
      ["meilisearch", "Meilisearch", "meilisearch"],
      ["fossil", "Fossil", "fossil"],
    ]);
  });

  test("admin UIs are filed under the service they administer", () => {
    const byKey = Object.fromEntries(servicesMenuGroups(served()).map((g) => [g.key, g]));
    expect(byKey.couchdb?.links.map((l) => l.label)).toEqual(["Fauxton"]);
    expect(byKey.garage?.links.map((l) => l.label)).toEqual(["Garage Web UI"]);
    // Meilisearch is its own UI as well as having a separate one.
    expect(byKey.meilisearch?.links.map((l) => l.label).sort()).toEqual([
      "Endpoint",
      "Meilisearch UI",
    ]);
    // Fossil serves its own web UI; there is no separate admin UI.
    expect(byKey.fossil?.links.map((l) => l.label)).toEqual(["Endpoint"]);
  });

  test("each service lists the stores it holds", () => {
    const byKey = Object.fromEntries(servicesMenuGroups(served()).map((g) => [g.key, g]));
    expect(byKey.couchdb?.stores.map((s) => s.name)).toEqual(["ct-sessions", "ct-logs"]);
    expect(byKey.couchdb?.stores[0]?.href).toBe("/api/couch/ct-sessions/");
    expect(byKey.couchdb?.stores[0]?.adminHref).toContain("#/database/ct-sessions/_all_docs");
    expect(byKey.garage?.stores).toEqual([{ kind: "buckets", key: "sessions", name: "ct-blobs" }]);
    expect(byKey.meilisearch?.stores[0]?.href).toMatch(/\/indexes\/ct-search$/);
    // Repositories read through the proxy by key; the web UI is Fossil's, by name.
    expect(byKey.fossil?.stores).toEqual([
      {
        kind: "repositories",
        key: "sessions",
        name: "ct-repo",
        href: "/api/fossil/sessions/json/timeline/checkin",
        adminHref: "http://127.0.0.1:7658/ct-repo/",
        adminLabel: "web ui",
      },
    ]);
  });

  test("a service whose feature is off is left out", () => {
    const groups = servicesMenuGroups(served({ ...CONFIG, features: { meilisearch: false } }));
    expect(groups.map((g) => g.key)).not.toContain("meilisearch");
  });

  test("operator links no service claims land in Other", () => {
    const groups = servicesMenuGroups(
      served({ ...CONFIG, servicesMenu: { grafana: "https://grafana.example/" } }),
    );
    const other = groups.at(-1);
    expect(other?.key).toBe("other");
    expect(other?.links).toEqual([
      {
        label: "grafana",
        href: "https://grafana.example/",
        subline: "https://grafana.example/",
        external: true,
      },
    ]);
  });

  test("an older webapi that serves no topology yields no groups, not a crash", () => {
    expect(servicesMenuGroups({ servicesMenu: {} })).toEqual([]);
    expect(servicesMenuGroups(undefined)).toEqual([]);
  });
});

describe("devMenuSections", () => {
  test("lists the routes the model marks for the menu, by section", () => {
    const sections = devMenuSections(served());
    expect(sections.map((s) => s.heading)).toEqual(["Reference", "Install"]);
    const reference = sections[0]?.links.map((l) => l.href) ?? [];
    expect(reference).toContain("/api/docs");
    expect(reference).toContain("/docs");
    expect(reference).not.toContain("/api/ingest");
    expect(sections[1]?.links.map((l) => l.href)).toEqual(["/cli/download"]);
  });
});

describe("aboutLinks", () => {
  test("derives the project links from the repository URL", () => {
    const links = aboutLinks(served());
    expect(links[0]?.href).toBe("https://github.com/vredchenko/claude-transcripts");
    expect(links.map((l) => l.label)).toEqual([
      "Source repository",
      "Issues",
      "Docs source",
      "License",
    ]);
  });

  test("is empty when the model names no repository", () => {
    expect(aboutLinks({ identity: { title: "x" } })).toEqual([]);
  });
});

describe("sessionLinks", () => {
  const id = "0b7e2c1a-1111-2222-3333-444455556666";

  test("an ended session links its summary doc, in the proxy and in Fauxton", () => {
    const labels = sessionLinks(served(), {
      sessionId: id,
      status: "ended",
      hasTranscript: true,
    }).map((l) => l.label);
    expect(labels).toEqual([
      "API JSON",
      "CouchDB events",
      "CouchDB summary",
      "Fauxton",
      "Transcript (S3)",
    ]);
  });

  test("a live session has no summary doc yet, so none is linked", () => {
    const links = sessionLinks(served(), {
      sessionId: id,
      status: "running",
      hasTranscript: false,
    });
    expect(links.map((l) => l.label)).toEqual(["API JSON", "CouchDB events"]);
  });

  test("links use the configured database and the bucket's logical key", () => {
    const links = sessionLinks(served(), { sessionId: id, status: "ended", hasTranscript: true });
    const href = (label: string) => links.find((l) => l.label === label)?.href;
    expect(href("CouchDB summary")).toBe(
      `/api/couch/ct-sessions/${encodeURIComponent(`summary:${id}`)}`,
    );
    expect(href("CouchDB events")).toContain(
      "/api/couch/ct-sessions/_design/events/_view/by_session",
    );
    expect(href("Transcript (S3)")).toBe(`/api/s3/sessions/${id}/transcript.jsonl`);
  });
});

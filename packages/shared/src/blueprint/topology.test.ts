/**
 * The diagram scene must stay tied to the blueprint it claims to project.
 *
 * The five hand-drawn ASCII diagrams this replaces drifted from each other and from
 * the code. The whole point of generating the picture is that a claim like "every
 * write goes through the webapi" (#288) becomes checkable, so these are the checks.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildAppBlueprint } from "./build";
import { toArchitectureDiagram } from "./project";
import { SERVICES } from "./services";
import { TOPOLOGY } from "./topology";
import type { AppConfigFile } from "./types";

const CONFIG: AppConfigFile = {
  system: { logging: { chunk: { maxEntriesPerChunk: 200, flushIntervalMs: 15000 } } },
  couchdb: { databases: { sessions: "s" } },
  s3: { buckets: { sessions: "s" } },
  features: { s3Blobs: true, meilisearch: true },
  servicesMenu: {},
};

const model = buildAppBlueprint(CONFIG, {});
const nodeKeys = new Set(TOPOLOGY.nodes.map((n) => n.key));
const serviceKeys = new Set(SERVICES.map((s) => s.key));

describe("topology integrity", () => {
  test("every serviceKey, edge endpoint and group member resolves", () => {
    for (const n of TOPOLOGY.nodes) {
      if (n.serviceKey) expect(serviceKeys).toContain(n.serviceKey);
    }
    for (const e of TOPOLOGY.edges) {
      expect(nodeKeys).toContain(e.from);
      expect(nodeKeys).toContain(e.to);
    }
    for (const g of TOPOLOGY.groups) {
      for (const m of g.members) expect(nodeKeys).toContain(m);
    }
  });

  test("every requiresFeature names a real feature flag", () => {
    // A typo here silently deletes a box from the diagram rather than failing.
    const flags = new Set(Object.keys(CONFIG.features));
    for (const n of TOPOLOGY.nodes) {
      if (n.requiresFeature) expect(flags).toContain(n.requiresFeature);
    }
    for (const e of TOPOLOGY.edges) {
      if (e.requiresFeature) expect(flags).toContain(e.requiresFeature);
    }
  });

  test("no client reaches a store: hook, webui, CLI and agents all end at the webapi", () => {
    // ADR 0016: the webapi is the single I/O interface (#288). A new edge from a
    // client to CouchDB, S3 or Meilisearch is the regression this exists to stop.
    const stores = new Set(TOPOLOGY.nodes.filter((n) => n.lane === "store").map((n) => n.key));
    const clients = ["hook", "webui", "cli", "agents"];
    for (const e of TOPOLOGY.edges.filter((e) => clients.includes(e.from))) {
      expect(stores.has(e.to)).toBe(false);
      expect(e.to).toBe("webapi");
    }
  });

  test("the hook writes, and only through the ingest surface", () => {
    const fromHook = TOPOLOGY.edges.filter((e) => e.from === "hook");
    expect(fromHook).toHaveLength(1);
    expect(fromHook[0]).toMatchObject({ to: "webapi", kind: "ingest" });
  });

  test("every write into a store comes from the webapi", () => {
    const writes = TOPOLOGY.edges.filter((e) => e.kind === "curated-write");
    expect(writes.length).toBeGreaterThan(0);
    for (const e of writes) expect(e.from).toBe("webapi");
  });
});

describe("toArchitectureDiagram", () => {
  test("compact is a subset of expanded", () => {
    // The invariant that makes growing the expanded view additive: it can never
    // remove or alter anything the README's compact view shows.
    const compact = toArchitectureDiagram(model, { level: "compact" });
    const expanded = toArchitectureDiagram(model, { level: "expanded" });
    const expandedNodes = new Set(expanded.nodes.map((n) => n.key));
    const edgeId = (e: { from: string; to: string; kind: string }) =>
      `${e.from}->${e.to}:${e.kind}`;
    const expandedEdges = new Set(expanded.edges.map(edgeId));

    for (const n of compact.nodes) expect(expandedNodes).toContain(n.key);
    for (const e of compact.edges) expect(expandedEdges).toContain(edgeId(e));
  });

  test("a disabled feature drops its node and every edge touching it", () => {
    const off = buildAppBlueprint(
      { ...CONFIG, features: { s3Blobs: false, meilisearch: true } },
      {},
    );
    const d = toArchitectureDiagram(off);
    expect(d.nodes.find((n) => n.key === "garage")).toBeUndefined();
    // The orphan prune: no arrow may point at a box that isn't drawn.
    for (const e of d.edges) {
      expect(e.from).not.toBe("garage");
      expect(e.to).not.toBe("garage");
    }
  });
});

/**
 * The architecture picture is drawn by hand (ADR 0035), so it can drift the way the
 * hand-typed diagrams before it did. This is the part of "is it still right?" a test
 * can answer: every component the topology has at the compact level is named in the
 * drawing, as a box or in a box's caption ("CLI — you + agents"). It catches a
 * component left out or renamed, not a wrong arrow.
 */
describe("the drawn stack diagram", () => {
  const draft = readFileSync(
    join(import.meta.dir, "../../../../scripts/stack-diagram/architecture.html"),
    "utf8",
  );
  const text = [...draft.matchAll(/<div class="(?:name|role)"><span>([^<]*)<\/span>/g)]
    .map((m) => m[1]!.toLowerCase())
    .join(" | ");

  test("names every compact topology node", () => {
    const missing = toArchitectureDiagram(model, { level: "compact" })
      .nodes.map((n) => n.label)
      .filter((label) => !new RegExp(`\\b${label.toLowerCase()}\\b`).test(text));
    expect(missing).toEqual([]);
  });
});

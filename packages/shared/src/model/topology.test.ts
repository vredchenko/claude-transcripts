/**
 * The diagram scene must stay tied to the model it claims to project.
 *
 * The five hand-drawn ASCII diagrams this replaces drifted from each other and from
 * the code: one said `CLI` where the others said `cli`, and every one of them routed
 * the hook *through* the webapi — the exact opposite of ADR 0016's amendment, which
 * is why the `_changes` follower exists. The whole point of generating the picture is
 * that such a claim becomes checkable, so these are the checks.
 */
import { describe, expect, test } from "bun:test";
import { buildAppModel } from "./build";
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

const model = buildAppModel(CONFIG, {});
const nodeKeys = new Set(TOPOLOGY.nodes.map((n) => n.key));
const serviceKeys = new Set(SERVICES.map((s) => s.key));

describe("topology integrity", () => {
  test("every serviceKey resolves against SERVICES", () => {
    for (const n of TOPOLOGY.nodes) {
      if (n.serviceKey) expect(serviceKeys).toContain(n.serviceKey);
    }
  });

  test("a node without a serviceKey carries its own label", () => {
    for (const n of TOPOLOGY.nodes) {
      expect(Boolean(n.serviceKey || n.label)).toBe(true);
    }
  });

  test("node keys are unique", () => {
    expect(nodeKeys.size).toBe(TOPOLOGY.nodes.length);
  });

  test("every edge endpoint resolves to a node", () => {
    for (const e of TOPOLOGY.edges) {
      expect(nodeKeys).toContain(e.from);
      expect(nodeKeys).toContain(e.to);
    }
  });

  test("every group member resolves to a node", () => {
    for (const g of TOPOLOGY.groups) {
      for (const m of g.members) expect(nodeKeys).toContain(m);
    }
  });

  test("no node is stranded without an edge", () => {
    const touched = new Set(TOPOLOGY.edges.flatMap((e) => [e.from, e.to]));
    for (const n of TOPOLOGY.nodes) expect(touched).toContain(n.key);
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

  test("the hook writes to the stores directly, not through the gateway", () => {
    // ADR 0016's amendment, and the invariant every ASCII diagram got backwards.
    const fromHook = TOPOLOGY.edges.filter((e) => e.from === "hook");
    expect(fromHook.length).toBeGreaterThan(0);
    for (const e of fromHook) {
      expect(e.kind).toBe("direct-write");
      expect(e.to).not.toBe("webapi");
    }
  });
});

describe("toArchitectureDiagram", () => {
  test("labels are read through the model, not copied", () => {
    const d = toArchitectureDiagram(model);
    const webui = d.nodes.find((n) => n.key === "webui");
    expect(webui?.label).toBe(SERVICES.find((s) => s.key === "webui")?.name);
  });

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
    const off = buildAppModel({ ...CONFIG, features: { s3Blobs: false, meilisearch: true } }, {});
    const d = toArchitectureDiagram(off);
    expect(d.nodes.find((n) => n.key === "garage")).toBeUndefined();
    // The orphan prune: no arrow may point at a box that isn't drawn.
    for (const e of d.edges) {
      expect(e.from).not.toBe("garage");
      expect(e.to).not.toBe("garage");
    }
  });

  test("nodes come out ordered by rank, stably", () => {
    const ranks = toArchitectureDiagram(model).nodes.map((n) => n.rank);
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
  });

  test("ports are omitted unless asked for", () => {
    expect(toArchitectureDiagram(model).nodes.every((n) => n.port === undefined)).toBe(true);
    const withPorts = toArchitectureDiagram(model, { includePorts: true });
    expect(withPorts.nodes.find((n) => n.key === "webapi")?.port).toBe(7650);
  });

  test("the projection is pure — two calls agree", () => {
    expect(toArchitectureDiagram(model)).toEqual(toArchitectureDiagram(model));
  });
});

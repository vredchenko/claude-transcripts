import type { TopologyEdgeDef, TopologyGroupDef, TopologyModel, TopologyNodeDef } from "./types";

/**
 * The **communication** topology — who talks to whom, and how.
 *
 * `services.ts` already calls itself "the canonical service topology", and it is:
 * for *deployment*. It says what runs, on which port, from which image. It says
 * nothing about the arrows, because `dependsOn` there exists only to emit compose
 * `depends_on` and is set on three services. The facts this file adds — that the
 * webui, CLI and agents reach everything through the gateway, and that the hook
 * deliberately does **not** — lived only in prose and in five hand-drawn ASCII
 * diagrams that had already drifted apart.
 *
 * Node labels and ports are read *through* `serviceKey` (see `toArchitectureDiagram`
 * in project.ts), never copied here, so renaming a service moves the diagram too.
 */

export const TOPOLOGY_NODES: TopologyNodeDef[] = [
  // ── rank 0 — the write lane starts with Claude Code, the read lane with the clients ──
  {
    key: "claude-code",
    label: "Claude Code",
    caption: "your sessions",
    role: "producer",
    icon: "claude",
    rank: 0,
    lane: "write",
    level: "compact",
    summary: "Fires a hook event at each session lifecycle point.",
  },
  {
    key: "webui",
    serviceKey: "webui",
    caption: "browse",
    role: "client",
    rank: 0,
    lane: "read",
    level: "compact",
    summary: "React SPA. Optional — losing it costs the UI, not the data.",
  },
  {
    key: "cli",
    serviceKey: "cli",
    caption: "script",
    role: "client",
    rank: 0,
    lane: "read",
    level: "compact",
    summary: "User-facing CLI and admin utility.",
  },
  {
    key: "agents",
    label: "agents",
    caption: "query",
    role: "client",
    rank: 0,
    lane: "read",
    level: "compact",
    summary: "Anything that speaks the OpenAPI contract.",
  },

  // ── rank 1 (write lane) — the second writer ──
  {
    key: "hook",
    label: "hook",
    caption: "the writer",
    role: "writer",
    rank: 1,
    lane: "write",
    level: "compact",
    ref: "design/decisions/0016-webapi-is-the-io-gateway.md",
    summary:
      "Writes each event, the end-of-session summary and the transcript blob directly, so recording never depends on the webapi being up.",
  },

  // ── rank 2 (read lane) — the stability column ──
  {
    key: "webapi",
    serviceKey: "webapi",
    caption: "the I/O gateway",
    role: "gateway",
    icon: "mark",
    rank: 2,
    lane: "read",
    level: "compact",
    ref: "design/decisions/0016-webapi-is-the-io-gateway.md",
    summary: "Every read goes through it; writes are never proxied.",
  },

  // ── rank 3 — where both lanes converge ──
  {
    key: "couchdb",
    serviceKey: "couchdb",
    label: "CouchDB",
    caption: "source of truth",
    role: "store",
    icon: "couchdb",
    rank: 3,
    lane: "store",
    level: "compact",
    summary: "Events, summaries and chunks. Append-only.",
  },
  {
    key: "garage",
    serviceKey: "garage",
    label: "Garage",
    caption: "transcript blobs",
    role: "store",
    icon: "garage",
    rank: 3,
    lane: "store",
    level: "compact",
    requiresFeature: "s3Blobs",
    ref: "design/decisions/0014-transcripts-live-in-s3-only.md",
    summary: "S3-compatible object storage — the transcript's sole durable home.",
  },
  {
    key: "meilisearch",
    serviceKey: "meilisearch",
    label: "Meilisearch",
    caption: "derived index",
    role: "index",
    icon: "meilisearch",
    rank: 3,
    lane: "store",
    level: "compact",
    requiresFeature: "meilisearch",
    summary: "Rebuildable full-text index. Optional — losing it costs search, not history.",
  },

  // ── rank 4: admin UIs. Declared now so the level filter is exercised and tested;
  //    only the compact level is rendered today.
  {
    key: "couchdb-fauxton",
    serviceKey: "couchdb",
    label: "Fauxton",
    role: "admin-ui",
    rank: 4,
    lane: "store",
    level: "expanded",
    summary: "CouchDB's built-in admin UI, served at /_utils/.",
  },
  {
    key: "garage-ui",
    serviceKey: "garage-ui",
    role: "admin-ui",
    rank: 4,
    lane: "store",
    level: "expanded",
    requiresFeature: "s3Blobs",
    summary: "Bucket and access-key admin for Garage.",
  },
  {
    key: "meilisearch-ui",
    serviceKey: "meilisearch-ui",
    role: "admin-ui",
    rank: 4,
    lane: "store",
    level: "expanded",
    requiresFeature: "meilisearch",
    summary: "Index browser for Meilisearch.",
  },
];

export const TOPOLOGY_EDGES: TopologyEdgeDef[] = [
  {
    from: "claude-code",
    to: "hook",
    kind: "emits",
    label: "each event",
    level: "compact",
    note: "hooks/scripts/dispatch.ts pipes the payload to `claude-transcripts hook run` and always exits 0.",
  },

  // The bypass. This is what every hand-drawn diagram got wrong: they routed the
  // hook through the webapi, which is the opposite of what ADR 0016's amendment says.
  {
    from: "hook",
    to: "couchdb",
    kind: "direct-write",
    label: "events + summary",
    level: "compact",
    ref: "design/decisions/0016-webapi-is-the-io-gateway.md",
    note: "Written directly, not through the gateway, so a webapi outage never loses a session.",
  },
  {
    from: "hook",
    to: "garage",
    kind: "direct-write",
    label: "transcript",
    level: "compact",
    requiresFeature: "s3Blobs",
    note: "The same bypass; transcript bytes live only in S3 (ADR 0014).",
  },

  { from: "webui", to: "webapi", kind: "http-client", label: "HTTP", level: "compact" },
  { from: "cli", to: "webapi", kind: "http-client", label: "HTTP", level: "compact" },
  { from: "agents", to: "webapi", kind: "http-client", label: "HTTP", level: "compact" },

  {
    from: "webapi",
    to: "couchdb",
    kind: "read-only-proxy",
    label: "reads · /api/couch",
    level: "compact",
  },
  {
    from: "webapi",
    to: "garage",
    kind: "read-only-proxy",
    label: "reads · /api/s3",
    level: "compact",
    requiresFeature: "s3Blobs",
  },
  {
    from: "webapi",
    to: "meilisearch",
    kind: "indexes",
    label: "search",
    level: "compact",
    requiresFeature: "meilisearch",
  },

  // Expanded only.
  {
    from: "webapi",
    to: "couchdb",
    kind: "curated-write",
    label: "/api/ingest",
    level: "expanded",
    note: "The curated write surface that owns the document shapes; writes are never proxied.",
  },
  {
    from: "couchdb",
    to: "webapi",
    kind: "changes-follower",
    label: "_changes",
    level: "expanded",
    note: "Exists because of the hook bypass: hook-written docs get no write-time validation.",
  },
  { from: "couchdb-fauxton", to: "couchdb", kind: "admin-of", level: "expanded" },
  { from: "garage-ui", to: "garage", kind: "admin-of", level: "expanded" },
  { from: "meilisearch-ui", to: "meilisearch", kind: "admin-of", level: "expanded" },
];

export const TOPOLOGY_GROUPS: TopologyGroupDef[] = [
  {
    key: "clients",
    title: "read / query",
    members: ["webui", "cli", "agents"],
    level: "compact",
  },
  {
    key: "stores",
    title: "your infrastructure",
    members: ["couchdb", "garage", "meilisearch"],
    level: "compact",
  },
];

export const TOPOLOGY: TopologyModel = {
  nodes: TOPOLOGY_NODES,
  edges: TOPOLOGY_EDGES,
  groups: TOPOLOGY_GROUPS,
};

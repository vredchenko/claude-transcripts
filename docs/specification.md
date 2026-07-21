# Technical specification — claude-transcripts

The complete technical writeup for the project: what it is, why it exists, how
it's built, and how to run it. It is the single entry point into the rest of
[`docs/`](.) — each section links to the detailed reference for that area. Where
this document and a topic doc overlap, the topic doc is authoritative.

> **Public-facing & homelab-agnostic.** This project is slated for a public
> release (Tier 3) and must run standalone for anyone, with **zero** assumptions
> about any specific homelab. Every backend is reached through documented env
> vars; everything else ships with sane public defaults.

## Contents

1. [Project summary](#1-project-summary)
2. [Objectives](#2-objectives)
3. [Feature tiers](#3-feature-tiers)
4. [System architecture](#4-system-architecture)
5. [Technology stack](#5-technology-stack)
6. [Prerequisites](#6-prerequisites)
7. [Installation](#7-installation)
8. [Components](#8-components)
9. [HTTP routes](#9-http-routes)
10. [Claude Code hooks & actions](#10-claude-code-hooks--actions)
11. [CouchDB conventions & design views](#11-couchdb-conventions--design-views)
12. [S3 (Garage) object storage](#12-s3-garage-object-storage)
13. [Search & the database/search-engine choice](#13-search--the-databasesearch-engine-choice)
14. [Configuration](#14-configuration)
15. [Application logging](#15-application-logging)
16. [Containers & packaging](#16-containers--packaging)
17. [Decision records (ADRs)](#17-decision-records-adrs)
18. [Competitive landscape](#18-competitive-landscape)
19. [Roadmap](#19-roadmap)

## 1. Project summary

**Self-hosted history for your [Claude Code](https://claude.com/claude-code)
sessions.** A Claude Code **hook** logs every session — events, an end-of-session
summary (counts, tool usage, token usage), and the full transcript — to your own
**CouchDB** + **S3-compatible** storage. A **web API** is the stable front door;
a **web UI** and a **CLI** read it back, and so can AI agents.

Everything runs on your own infrastructure. Nothing leaves your network. Claude
Code keeps transcripts locally per machine, where they're easy to lose and hard to
look across; this turns that into a **durable, queryable, self-hosted record** of
your AI-assisted work on vendor-neutral backends you control.

```
Claude Code ──hook──► webapi ──► CouchDB + S3        webui ─┐
                        ▲                             CLI  ──┼─► webapi
                        └───────── reads/writes ──────agents┘
```

## 2. Objectives

**Near-term:** recreate, as one standalone project, durable session capture +
browse/search + programmatic access. **North star** ([#15](roadmap.md)): the
primary consumer is eventually **Claude Code itself** — a structured, searchable,
replicated corpus a later session can recall from and self-learn from. Human
browse/search is secondary. This motivates the append-only document model, the
mid-flight chunking, and the search/recall roadmap. The competitive survey
([§18](#18-competitive-landscape)) confirms our differentiator: most tools store
*distilled* memory and discard the transcript — we keep the **byte-faithful
transcript as ground truth** and treat distillation as an optional derived layer.

## 3. Feature tiers

Three stacking tiers, each independently useful, each forbidden from breaking the
one below ([tiers.md](tiers.md), [ADR 0015](decisions/0015-tiered-architecture.md)):

- **Tier 1 — single machine, single user.** Localhost Docker Compose + registered
  hook. Transcript retention/persistence + browse/search (webui) + programmatic
  access (webapi/CLI). **No auth/security** (trusted single user); the **bundled
  backends default to no auth**, localhost only
  ([ADR 0020](decisions/0020-bundled-services-default-no-auth.md)). webapi + CouchDB
  are core; webui, CLI, Meilisearch, S3 are optional.
- **Gate (T1 → T2):** an **end-to-end test suite** that fakes a Claude Code session
  and drives the system e2e ([testing.md](testing.md)).
- **Tier 2 — make history actively useful.** Multi-system/user attribution,
  analytics/dashboards, and agent features: recall during live sessions,
  self-learning, pattern/template extraction, external sync.
- **Tier 3 — multiplayer & public release.** Masterless replication, auth/security,
  static-HTML docs in the combined container, hook-drift automation, a
  **scheduled-task service** (lightweight FOSS functions for stats / summaries /
  anomaly detection), **session export to PDF/Markdown/JSON**, and bundled
  extensibility (OpenHack, Fossil, integration points).

## 4. System architecture

**Everything goes through the webapi**
([ADR 0016](decisions/0016-webapi-is-the-io-gateway.md)): the hook writes through
it; the webui, CLI, and agents read/write through it. The webapi is
**non-optional** — the *stability column* whose contract holds even as internals
change, break, or toggle. It transparently proxies, **read-only**, to CouchDB
(`/api/couch`) and S3 (`/api/s3`) where their native API is itself a useful
surface; **writes are never proxied** — they go through curated endpoints that own
the document/blob shapes.

**Core vs optional** (graceful degradation is a first principle): webapi + CouchDB
are core; webui, CLI, Meilisearch, and S3 are optional/removable — losing one
degrades a feature, never the system. Full detail in
[architecture.md](architecture.md) and [tiers.md](tiers.md).

## 5. Technology stack

| Area | Choice | Notes |
|------|--------|-------|
| Language / runtime | **Bun** + **TypeScript** (ESM, strict) | One toolchain across hook + app + CLI. [ADR 0004](decisions/0004-bun-monorepo-hook-as-standalone-plugin.md) |
| Repo shape | **Bun workspace monorepo** | `packages/*` + standalone `hooks/` + `scripts/` (+ a CLI package). |
| Document store | **CouchDB** | Schemaless, append-only; map-reduce views; HTTP-native; masterless replication = the Tier-3 multiplayer model. [ADR 0007](decisions/0007-couchdb-primary-store.md), [database-choice.md](database-choice.md) |
| Object store | **S3-compatible (Garage)** | Blobs via Bun's `S3Client`; MinIO/R2/AWS by env. [ADR 0008](decisions/0008-garage-s3-object-store.md) |
| webapi | **Hono** + `@hono/zod-openapi`, `nano`, `Bun.S3Client` | The I/O gateway; OpenAPI spec is the contract source of truth. |
| webui | **React 19** + **Vite** + **MUI**, TanStack Query | Optional SPA; uses a **generated** API client. |
| CLI | **Bun + Ink** | Same stack as Claude Code; generated API client; optional interface + admin tool. [cli.md](cli.md) |
| API clients | **Generated from the OpenAPI spec** | webui + CLI share one typed boundary. [ADR 0019](decisions/0019-openapi-source-of-truth-generated-clients.md) |
| Lint/format | **Biome** + **lefthook** | 2-space, double quotes, width 100. |
| Search | **Meilisearch** (core, removable/swappable) | Lexical/human search; Tier-2 agent retrieval likely adds a vector index. [ADR 0009](decisions/0009-meilisearch-search.md), [database-choice.md](database-choice.md) |
| CI / releases | **GitHub Actions** + GitHub Container Registry (GHCR) | Tag-driven combined-image build. [ADR 0012](decisions/0012-github-actions-and-ghcr-for-releases.md) |

Scope is **Claude-Code-specific by design**, not a generic agent-session logger
([ADR 0010](decisions/0010-claude-code-specific-scope.md)).

## 6. Prerequisites

- A reachable **CouchDB** and an **S3-compatible bucket** — the bundled `deploy/`
  stack or your own. The bucket must already exist.
- **[Bun](https://bun.sh)** on each machine where you run Claude Code (the hook).
- **Docker + Docker Compose** for the bundled stack.
- **Claude Code** itself, to install the hook as a plugin.

## 7. Installation

Bring your own backends (`cd deploy && cp .env.example .env && docker compose up -d`)
or the bundled stack (`docker compose --profile full up -d`). Then install the hook
on each Claude Code machine:

```bash
cd hooks
ENV_FILE=../.env bash scripts/setup.sh   # runtime config, ensure DB + views
bun run scripts/smoke-test.ts            # verify the write path
claude plugin install "$(pwd)"           # register the hooks
```

Full steps in [`README.md`](../README.md), [hook-setup.md](hook-setup.md), and
[`deploy/README.md`](../deploy/README.md).

## 8. Components

| Component | Path | Role | Reference |
|-----------|------|------|-----------|
| **hook** | `hooks/` | Claude Code plugin (writer). Logs through the webapi path to CouchDB + S3. Per machine. | [hook.md](hook.md) |
| **webapi** | `packages/webapi/` | The I/O gateway + stability column; ensures the CouchDB schema; serves the SPA + Swagger in prod. | [webapi.md](webapi.md) |
| **webui** | `packages/webui/` | Optional React SPA: list, detail, transcript viewer. Generated API client. | [webui.md](webui.md) |
| **CLI** | _(planned package)_ | Optional Bun + Ink terminal client + admin tool; generated API client. | [cli.md](cli.md) |
| **shared** | `packages/shared/` | Cross-cutting domain types + `sumTranscriptTokens`. | [webapi.md](webapi.md#packagesshared) |
| **scripts** | `scripts/` | Dev-only automation + operational helpers: transcript parsing, `backfill`, reconcile, export/import, migrations. | [cli.md](cli.md) |
| **deploy** | `deploy/` | docker-compose stack (bundled or external backends). | [deploy/README.md](../deploy/README.md) |

## 9. HTTP routes

One combined container serves everything under one origin: `/` (a **machine
-readable app manifest** — the agent entrypoint: routes, config, dynamic links,
version/build — **not** a UI page, [ADR 0022](decisions/0022-root-route-is-a-machine-readable-manifest.md)),
`/api` (app endpoints), `/api/docs` (Scalar API reference), `/api/couch/*` and `/api/s3/*`
(read-only proxies), `/app` (webui SPA, with a CLI download link), and — Tier 3 —
static HTML docs. Backing-service admin UIs (Fauxton, Garage WebUI, Meilisearch)
are reached directly and linked from the webui Services menu. Full table in
[routes.md](routes.md).

## 10. Claude Code hooks & actions

**Hook types** and **actions** are kept as two separate lists with a composable
**many-to-many mapping** ([ADR 0017](decisions/0017-hooks-and-actions-decoupled.md)).
The goal is a handler for **every** Claude Code hook type (placeholder where no
action is bound yet), so Tier-3 CI can diff our list against an external source of
truth. Eight events are wired today, all observe-only. The canonical hook list is
[hooks.md](hooks.md); the behaviour catalogue + current bindings are
[actions.md](actions.md).

## 11. CouchDB conventions & design views

A single append-only database (`claude-sessions`) of typed docs — `event`,
`summary:<id>`, and `chunk:<id>:<byte_start>` — every doc carrying a `type` and an
explicit `timestamp`, keyed by Claude Code's own `session_id`. Map-reduce design
views do the aggregation, mirrored in `hooks/couchdb/` and the webapi's `ensure.ts`
(kept in sync). Full doc schemas + view catalogue in [couchdb.md](couchdb.md);
schema/view evolution is handled by **self-built migrations**
([migrations.md](migrations.md), [ADR 0021](decisions/0021-self-built-couchdb-migrations.md)).

## 12. S3 (Garage) object storage

S3 holds the durable, full-fidelity blobs that don't belong in the document store:
`<bucket>/<sessionId>/{summary.json,transcript.jsonl}`. The transcript lives in S3
**only** ([ADR 0014](decisions/0014-transcripts-live-in-s3-only.md)) and is read
back through the webapi (and the `/api/s3` read proxy). Vendor-neutral via Bun's
`S3Client` — Garage / MinIO / R2 / AWS by env. S3 is **core but removable**: drop
it and you lose blob backups + pruned-content escrow, but CouchDB (the source of
truth) still persists the data. The app never creates the bucket.

## 13. Search & the database/search-engine choice

Search is a **per-node derived index** rebuilt from CouchDB (`_changes`), not
replicated. **Meilisearch** covers lexical/human search (core, removable, or
swappable for Typesense). Tier-2 agent retrieval is a semantic workload that will
likely add a **vector index** (Qdrant/LanceDB) behind a webapi `/api/search`
abstraction. The standing assessment — **keep CouchDB, keep Meilisearch, plan for
vectors** — with the reasoning and the alternatives weighed (no Mongo/Elastic/
Postgres) is in [database-choice.md](database-choice.md).

## 14. Configuration

Two layers: non-secret deployment-wide defaults in the committed
`claude-transcripts.config.json` (names, feature toggles, tunables, service URLs), overlaid with
secrets/endpoints in a per-machine `.env`. The same image runs against **bundled**
(local Compose) or **external** (remote CouchDB + Cloudflare R2 + hosted search)
backends — topology is pure env. The design goal is **everything configurable**,
extending this one file rather than adding a second source. Full reference:
[configuration.md](configuration.md).

## 15. Application logging

The system's **own** logs (webapi, webui, CLI, hook failures/errors) aggregate
into **CouchDB, in a separate database** from the session data, written through the
webapi ([ADR 0018](decisions/0018-app-logging-into-couchdb.md)). Optional — absent,
components fall back to local logs. Schema + retention are placeholders;
[app-logging.md](app-logging.md).

## 16. Containers & packaging

One combined image (webapi + webui + Swagger + bundled CLI + Tier-3 static docs)
under one origin ([ADR 0002](decisions/0002-single-combined-container.md)), built
from a planned family of pinned **base images** (Bun runtime, Claude-Code runtime,
CLI-utils, OpenHack, Fossil/SCM, and our own CouchDB/Meilisearch/Garage builds).
Future extensibility (bundled cybersec tooling, integration points) is Tier 3.
Detail in [containers.md](containers.md).

## 17. Decision records (ADRs)

Non-obvious decisions are recorded in [`decisions/`](decisions/) (format:
[ADR 0001](decisions/0001-record-architecture-decisions.md)). Recent additions:
**0015** tiered architecture · **0016** webapi as the sole I/O gateway / stability
column · **0017** hooks/actions decoupled · **0018** app logging into CouchDB ·
**0019** OpenAPI source of truth + generated clients (supersedes 0006) · **0020**
bundled services default to no auth · **0021** self-built CouchDB migrations ·
**0022** `/` is a machine-readable app manifest · **0023** lockstep versioning +
separate-build-then-combine image · **0024** mirror backing images to GHCR ·
**0025** generated CC compatibility matrix · **0026** single-`main` branch model.
Full table: [decisions/README.md](decisions/README.md).

## 18. Competitive landscape

A survey of 12 OSS projects in the AI-memory / session-logging / self-learning
space (filed as issues #18–#29, indexed by #30) informs the design — closest
direct competitors are **claude-mem** and **claude-self-reflect**; the memory-model
ideas worth borrowing come from **Mem0**, **Zep/Graphiti**, **Letta**, and
**Basic Memory**; the session-data-model and packaging references come from
**Langfuse**, **Phoenix**, and **Laminar**. Synthesis + comparison table:
[competitive-landscape.md](competitive-landscape.md).

## 19. Roadmap

Phase 1 is standalone logging + viewing. Search, the agent-first corpus redesign,
recall, analytics, multiplayer, and richer ingest/metadata are tracked as GitHub
issues and mapped to tiers in [roadmap.md](roadmap.md).

# Feature tiers

The project is built as **three tiers that stack**. Each tier is a strict
superset of the one below — nothing in a higher tier may break a lower tier, and
every tier is independently useful. The repo lives on GitHub; the public
release is a Tier-3 concern.

> The organizing principle is **graceful degradation**: the core
> (webapi + CouchDB) must always work; everything else is optional and degrades
> features, not the system. See [architecture.md](architecture.md) and
> [ADR 0016](decisions/0016-webapi-is-the-io-gateway.md).

## Tier 1 — single machine, single user

**The problem it solves:** session-transcript **retention and persistence** on one
machine for one user, plus the ability to **search/browse** that history (webui)
and **integrate programmatically** (webapi/CLI).

- **Topology:** everything on `localhost`. A Docker Compose stack
  (CouchDB + Garage + Meilisearch + the app container) + the Claude Code hook
  registered against it. Minimal system setup.
- **Security:** **none required, by design.** No auth, no access control, no
  network exposure beyond localhost. Tier 1 explicitly assumes a trusted single
  user on a trusted machine. The **bundled** backing services default to **no
  auth** — no tokens/keys/passwords to supply (CouchDB open, Meilisearch no master
  key, Garage with a pre-baked default key); see
  [ADR 0020](decisions/0020-bundled-services-default-no-auth.md). The stack binds
  to localhost only.
- **What you get:**
  - Durable session capture (events + summary + transcript) beyond local log
    rotation.
  - Browse/search every session in the **webui**.
  - Full programmatic access via the **webapi** (and, through it, transparent
    read access to CouchDB docs/views and S3 blobs).
  - A **CLI** for the same operations — handy for humans *and* for AI agents
    driving the system headless.
- **Optional within Tier 1** (toggle off, lose only the named feature):
  - **webui** — turn it off and drive everything via the CLI/API.
  - **Meilisearch** — off ⇒ lose full-text/semantic search; or swap for another
    search backend.
  - **S3 / Garage** — off ⇒ lose blob backups and pruned-content escrow; as long
    as the webapi + CouchDB are up, **data still persists** (CouchDB is the
    source of truth).
- **Non-optional:** the **webapi** and **CouchDB**. The webapi is the stability
  column (see below); CouchDB is the durable store.

### Tier-1 build scope

The concrete deliverables for Tier 1:

- **Structured app config** — `system` (core constants e.g. chunk buffer), empty
  `userSettings`, and `.env` with full endpoint paths + non-secret/default values;
  **multi-database / multi-bucket** name maps from the start
  ([configuration.md](configuration.md)).
- **CouchDB doc schemas defined in code** + the self-built **migration** tool
  ([couchdb.md](couchdb.md), [migrations.md](migrations.md)).
- **webapi scaffold** — Bun + Hono + OpenAPI (the I/O gateway) ([webapi.md](webapi.md)).
- **CLI scaffold** — Bun + Ink, an aggregate of internal modules (generated webapi
  client, `.claude/` reader, hooks-setup, import/export) ([cli.md](cli.md)).
- **webui** — build forward from the current React + MUI SPA (router, central
  state, virtual scroll/lazy-load, generated client) ([webui.md](webui.md)).
- **Dev automation** — `scripts/` (orval client generation → CLI + SPA), run
  locally and wrapped in CI ([dev-automation.md](dev-automation.md)).
- **Dev full-stack compose** — CouchDB + Garage + Meilisearch + admin UIs on the
  dev port range; app runs on host in dev, joins the stack in deploy
  ([containers.md](containers.md)).
- **Mirrored backing images** in GHCR; **lockstep semver**, build
  components separately then combine into one image
  ([ADR 0024](decisions/0024-mirror-backing-images-to-registry.md),
  [ADR 0023](decisions/0023-lockstep-versioning-and-combined-image.md)).
- **Claude Code compatibility** definition + the `latestPublic`/hooks generator;
  the **master hook table** ([compatibility.md](compatibility.md), [hooks.md](hooks.md)).
- Work on the single **`main`** branch ([branching.md](branching.md)).

This is the tier the repo targets first. See
[specification.md](specification.md#7-installation) and [hook-setup.md](hook-setup.md).

## Gate: end-to-end test suite (after Tier 1, before Tier 2)

Before building Tier-2 features, land an **end-to-end test suite that fakes a
Claude Code session and drives the system end-to-end** (synthesize the hook event
stream + transcript → write through the system → assert via the webapi/proxies),
running against the repo's own bundled stack. This verifies the Tier-1 base so
active-use features are built on solid ground. Design in [testing.md](testing.md).

## Tier 2 — make history actively useful

Tier 2 keeps the single-container core but adds the features that turn a passive
archive into an **active asset for future sessions**, and broadens beyond one
machine/user. Requirements collected here (each becomes its own design note +
issue):

- **Multi-system / multi-user** capture and attribution (still pre-multiplayer):
  actor = (user, machine) provenance on every session ([#7](roadmap.md)).
- **Enhanced reports / dashboards / analytics** over session data.
- **Agents that learn from history:**
  - generalise and **self-learn** from past sessions;
  - **actively search history during a live session** for context (recall);
  - **extract patterns / habits / preferences** from specific projects into
    common, reusable ways of doing things — and surface **candidates for
    documented, templated solutions**;
  - agents that **update something external** to match conversation history.
- **The point of Tier 2:** session logs become *input* to future work, not just a
  record of past work.

Tier 2 is where search (Meilisearch and/or a vector index) and the recall plugin
([#9](roadmap.md), [#10](roadmap.md)) earn their keep. Still no hard security
requirement if deployed single-user; multi-user sharpens the need for the
metadata layer but not yet auth.

## Tier 3 — multiplayer & public release

Everything required to run this as shared, multi-party, public-facing software:

- **Multiplayer** — true multi-party history via CouchDB's masterless
  multi-master replication ([#15](roadmap.md)); the append-only/immutable
  document model in Tier 1 is what makes this *additive* rather than a rewrite.
- **Public release** packaging — a single combined container that serves the
  **static HTML docs**, the **Swagger** spec, the **webui**, and the **webapi**
  together ([containers.md](containers.md)).
- **Auth / security / isolation** — introduced here, not before.
- **Hook drift automation** — CI that checks the codebase's Claude Code hook list
  against an external source of truth ([hooks.md](hooks.md)).
- **Scheduled-task service** — a lightweight, self-hosted FOSS "functions" runner
  (think localhost Cloudflare-Workers-style **scheduled, stateless tasks**, not a
  full FaaS): scheduled scripts that operate on top of the existing system —
  statistics & analysis, content-derived summaries, anomaly detection, periodic
  rollups. Runs over the webapi/CouchDB; no new state of its own.
- **Session export** — export a session (or a selection) to **PDF / Markdown /
  JSON**, surfaced via the CLI and webui (builds on the import/export +
  [migrations](migrations.md) machinery).
- **Extensibility & bundled tooling** (future) — bundle the OpenHack cybersec
  repo, optionally a Fossil/git-like layer, a source-code search util, and expose
  our own integration points for third-party extensions.

## What is core vs optional (summary)

| Component | Tier | Core / optional | If removed |
|-----------|------|-----------------|-----------|
| **webapi** | 1 | **core, non-optional** | system has no stable API surface — not allowed |
| **CouchDB** | 1 | **core** | no durable store — not allowed |
| webui | 1 | optional interface | lose the browser UI; CLI/API still work |
| CLI | 1 | optional interface + admin tool | lose the terminal UX + agent-driving convenience |
| Meilisearch | 1→2 | core, removable/swappable | lose search features |
| S3 / Garage | 1 | core, removable | lose blob backups + pruned-content escrow; CouchDB still persists data |
| App-log DB | 1/2 | optional | lose centralised app/error logs (see [app-logging.md](app-logging.md)) |
| Multiplayer / auth | 3 | added in Tier 3 | n/a below Tier 3 |

The decision to make the webapi the single non-optional gateway is recorded in
[ADR 0016](decisions/0016-webapi-is-the-io-gateway.md); the tier model itself in
[ADR 0015](decisions/0015-tiered-architecture.md).

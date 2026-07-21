# Roadmap

The work is organised into **three stacking tiers** ([tiers.md](tiers.md)):
**Tier 1** single-machine retention + browse/search (current focus), **Tier 2**
making history actively useful to future agents (recall, self-learning, analytics,
multi-user), **Tier 3** multiplayer + public release. The future-scope issues
below map onto Tiers 2–3. A [competitive-landscape](competitive-landscape.md)
survey (issues #18–#30) informs the Tier-2 recall/memory direction.

**Phase 1** (current, Tier 1) recreates, as a single standalone project, the
logging + viewing that previously lived across several repos. The items below are
intentionally not built yet (Meilisearch ships in the stack but is not wired up).
The UI is functional but deliberately unstyled — a visual rework comes later.

The next major piece is the **logging rework** (#4): persist session content
mid-flight (crash resilience) and store the full session log as chunked docs in
CouchDB so map-reduce views can extract session features. (Dropping CouchDB
transcript attachments — the first part of that rework — is **done**: transcripts
now live in S3 only, see
[ADR 0014](decisions/0014-transcripts-live-in-s3-only.md).) It's the phase-in
blocker and is being planned before implementation.

## Tier 1 build (current scope)

The concrete Tier-1 deliverables are enumerated in
[tiers.md → Tier-1 build scope](tiers.md#tier-1-build-scope): structured app config
(multi-db/bucket), CouchDB schemas-in-code + migrations, webapi/CLI/webui scaffolds,
dev automation (orval client gen), the dev full-stack compose + admin UIs, mirrored
backing images, lockstep versioning + combined image, the CC compatibility
generator + hook table, and the single-`main` branch model. The **e2e test suite**
([testing.md](testing.md)) is the gate from Tier 1 into Tier 2.

## Future scope → captured in docs

The design discussion that used to live in the issue tracker has been **folded
into `docs/` and the tracking issues closed** (only the competitor-study issues
**#18–#30** remain open). This section is the tier-mapped index; the original issue
number is kept in parentheses for provenance. Items are open work unless marked
done.

**North star (Tier 2/3)**
- Agent-first session corpus — recall + self-retrospective, CC as the primary
  consumer; single-instance-but-multiplayer-aware now, multiplayer later
  ([tiers.md](tiers.md), [session-corpus-design-discussion.md](session-corpus-design-discussion.md)) (#15)
- Evaluate DeltaDB-style delta granularity ([database-choice.md](database-choice.md)) (#16)

**Logging & data model (Tier 1/2)**
- Persist mid-flight + chunked CouchDB logs for map-reduce feature views
  ([mid-flight-chunking.md](mid-flight-chunking.md)) (#4)
- Session enrichment: harness config / PROMPT / MCP / plugins / CLI version
  ([actions.md](actions.md), [hooks.md](hooks.md)) (#3)
- Multi-user / multi-machine attribution ([tiers.md](tiers.md) → T2) (#7)
- Secrets scanning + masking ([app-logging.md](app-logging.md), #11)
- **Self-built CouchDB migrations** — up/down + views + export/import bundles
  ([migrations.md](migrations.md), [ADR 0021](decisions/0021-self-built-couchdb-migrations.md))

**Ingest & lifecycle (Tier 1/2)**
- `backfill` — "adopt this machine's history" as first-class records
  (summary + per-event docs, planned chunks) ([tools.md](tools.md)) (#6)
- Full Claude Code hook-type coverage + drift check ([hooks.md](hooks.md), #5/#13)

**Quality (Tier 1 → Tier 2 gate)**
- **End-to-end test suite** faking a CC session and driving the system e2e
  ([testing.md](testing.md))

**Search & recall (Tier 2)**
- Meilisearch search + typeahead; vector index for agent retrieval
  ([database-choice.md](database-choice.md)) (#9)
- Claude Code recall plugin ([tiers.md](tiers.md) → T2) (#10)

**Webui (Tier 2)**
- Configurable session-list columns + virtual scroll (#8)
- Config-driven services menu, fed by the `/` manifest ([routes.md](routes.md)) (#14)

**Tier 3 — multiplayer & public release**
- Masterless replication + auth/security ([tiers.md](tiers.md), [ADR 0015](decisions/0015-tiered-architecture.md))
- Static-HTML docs in the combined image ([containers.md](containers.md))
- **Scheduled-task service** — lightweight FOSS "functions" for stats / summaries /
  anomaly detection over the corpus ([tiers.md](tiers.md))
- **Session export to PDF / Markdown / JSON** ([tiers.md](tiers.md))
- Extensibility & bundled tooling (OpenHack, Fossil, integration points)

> Earlier "consider" issues, now noted here: codebase search (#1), logging CC web
> traffic (#2).

# 15. Tiered architecture (Tier 1 / 2 / 3)

Date: 2026-06-18

## Status

Accepted

## Context

The project's ambitions span a wide range — from "retain my Claude Code
transcripts on one laptop" to "a replicated, multi-user corpus that agents
actively learn from." Trying to design for all of it at once risks either
over-building the simple case or baking in single-machine assumptions that block
the advanced case.

## Decision

Organise scope into **three stacking tiers**, each a strict superset of the one
below, each independently useful, with the rule that **nothing in a higher tier
may break a lower tier**:

- **Tier 1 — single machine, single user.** Localhost Docker Compose +
  registered hook. Solves transcript retention/persistence + browse/search
  (webui) + programmatic access (webapi/CLI). **No auth, no security** — trusted
  single user. webapi + CouchDB are non-optional core; webui, CLI, Meilisearch,
  S3 are optional/removable.
- **Tier 2 — make history actively useful.** Multi-system/user attribution,
  analytics/dashboards, and the agent-facing features (recall during live
  sessions, self-learning, pattern/template extraction, external sync).
- **Tier 3 — multiplayer & public release.** Masterless replication, auth/security,
  static-HTML docs in the combined container, hook-drift automation, bundled
  extensibility tooling.

The full feature breakdown lives in [tiers.md](../tiers.md).

## Consequences

- Tier 1 ships first and stays simple; we don't gate it on auth or multiplayer.
- Tier-1 invariants are chosen to make Tier 3 **additive** — most importantly the
  append-only/immutable document model (so CouchDB replication is conflict-free)
  and the webapi-as-sole-gateway rule ([ADR 0016](0016-webapi-is-the-io-gateway.md)).
- "Single-instance but multiplayer-aware" is an explicit Tier-1 design constraint,
  not an afterthought (see #15).
- Roadmap items and issues are labelled by tier so scope discipline is legible.

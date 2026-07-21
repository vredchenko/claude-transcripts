# 1. Record architecture decisions

Date: 2026-06-06

## Status

Accepted

## Context

This project was consolidated from three pre-existing sources (a predecessor
Claude Code logging plugin, a predecessor webapi/webui, and a monorepo repo used
as a structural template). A number of non-obvious choices were made during that
consolidation —
some purely engineering, some about which backing technologies to standardise on.
Future contributors (human or agent) need to know *why*, not just *what*, so the
decisions survive the loss of the originating context.

## Decision

We keep lightweight Architecture Decision Records (ADRs) in `docs/decisions/`,
one Markdown file per decision, numbered sequentially (`NNNN-title.md`). Each
record states Context, Decision, and Consequences, and carries a Status
(Proposed / Accepted / Superseded).

A decision is ADR-worthy when it (a) constrains future work, (b) chose one option
over viable alternatives, or (c) would otherwise prompt a "why is it like this?"
question later. Routine implementation details are not.

## Consequences

- Decisions are discoverable and reviewable in-repo, versioned with the code.
- Superseding a decision is itself a new ADR that links back, rather than an edit.
- Records 0007+ capture the backing-technology rationale (CouchDB, Garage,
  Meilisearch, Claude-Code-specific scope); they are written from the owner's
  freeform rationale rather than invented.

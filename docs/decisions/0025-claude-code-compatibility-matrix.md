# 25. Claude Code compatibility is a generated, structured definition

Date: 2026-06-18

## Status

Accepted

## Context

The system is a Claude Code logger ([ADR 0010](0010-claude-code-specific-scope.md)),
so it has a hard dependency on Claude Code's hook surface, which changes across CLI
versions. We need to know, precisely and verifiably, which Claude Code versions we
support and which hooks each version exposes — and we don't want that drifting out
of date by hand.

## Decision

Track Claude Code compatibility as a **structured, formal, machine-generated
definition** (a committed `compatibility.json`, [compatibility.md](../compatibility.md)),
not prose:

- It records three versions — **`latestPublic`**, **`latestCompatible`**,
  **`earliestCompatible`** — and the **complete supported-hook list for each**.
- **`latestPublic` + the per-version hook lists are auto-generated** from an
  **external source of truth** (Claude Code's published hooks docs / release
  metadata) by a dev script, runnable locally and in CI
  ([dev-automation.md](../dev-automation.md)).
- **`earliestCompatible` / `latestCompatible`** are determined by **test
  automation** (a future suite that runs the [e2e tests](../testing.md) against
  multiple CC versions), not by hand.
- The same generated data backs the **hook-drift check** (Tier 3, #13): diff the
  codebase's hook list ([hooks.md](../hooks.md)) against the generated truth.

## Consequences

- "Which versions / hooks do we support?" has one authoritative, regenerable
  answer — no stale hand-maintained list.
- Tier 1 ships the **structure + the `latestPublic` generator**; the
  compatibility-window automation is gated on the e2e suite (a later milestone).
- Adds an external-source-scraping dependency in CI; if the source format changes,
  the generator needs maintenance — accepted, as the alternative is silent drift.

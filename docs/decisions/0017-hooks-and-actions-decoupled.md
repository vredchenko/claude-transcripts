# 17. Hooks and actions are decoupled (many-to-many)

Date: 2026-06-18

## Status

Accepted

## Context

Today each Claude Code hook event maps to one handler module, and the registered
set is a deliberate subset of eight events. We want two things that the current
shape conflates:

1. A handler for **every** Claude Code hook type that exists (so coverage is
   complete and, in Tier 3, a CI job can diff our hook list against an external
   source of truth and flag drift).
2. Freedom to define **what we do** on an event independently of **which event**
   triggered it — the same action (e.g. "append a content chunk", "write an event
   marker", "extract URLs") may be driven by several events, and one event may
   drive several actions.

A fixed event→handler mapping can't express that cleanly.

## Decision

Model **hooks** and **actions** as two separate, independently-maintained lists,
with an explicit **many-to-many mapping** between them.

- **Hook types** — the canonical list of Claude Code hook events, one entry per
  event that exists in Claude Code, each with a (possibly no-op/placeholder)
  handler. Maintained as data so it can be validated against an external source
  of truth (Tier 3 drift check). See [hooks.md](../hooks.md).
- **Actions** — the catalogue of event-handling behaviours the system can perform
  (write event-marker doc, flush transcript chunk, update counts, extract feature,
  enrich metadata, …), defined independently of any specific hook. See
  [actions.md](../actions.md).
- **Mapping** — a composable, configurable many-to-many binding: event *E* fires
  actions *{A, B, …}*; action *A* may be bound to events *{E, F, …}*. The dispatch
  layer resolves the mapping at runtime.

## Consequences

- Complete hook coverage becomes a data-completeness property we can test, not a
  matter of how many handler files exist.
- Behaviours are reusable across events and composable per deployment (configurable
  bindings — fits the "everything configurable" goal).
- The current `REGISTRY` in `dispatch.ts` is the seed of the mapping table; it
  generalises from "event → handler module" to "event → action set".
- Adds an indirection layer; kept simple (a declarative mapping) so it doesn't
  obscure the write path.

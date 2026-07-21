# Claude Code hook types

How Claude Code **hook events** map to **what we do** — kept deliberately separate
from the event catalogue itself. The behaviours are the [actions catalogue](actions.md),
bound to events via a composable **many-to-many mapping**
([ADR 0017](decisions/0017-hooks-and-actions-decoupled.md)).

> **The event catalogue lives in [hook-events.md](hook-events.md)** — every Claude
> Code hook event, when it fires, its payload, example fixtures, and the action(s)
> we run. That table is **generated** from the app model
> ([`HOOK_TYPES`](../packages/shared/src/model/hooks.ts)); this page narrates the
> binding model behind its "What we do" column. Don't maintain a second event list
> here. The authoritative *per-version* list is generated into `compatibility.json`
> ([compatibility.md](compatibility.md), [ADR 0025](decisions/0025-claude-code-compatibility-matrix.md)).

## Hooks → actions (the binding model)

A hook event doesn't hard-code a behaviour; it resolves to a **set of actions**:

- **[`HOOK_TYPES`](../packages/shared/src/model/hooks.ts)** — the events (with
  `wired` marking the ones bound today).
- **[`ACTIONS`](../packages/shared/src/model/actions.ts)** — the catalogue of
  event-handling behaviours, defined independently of any hook ([actions.md](actions.md)).
- **`BINDINGS`** (same file) — the many-to-many `event → actions[]` table.

`dispatch.ts` reads an incoming event and runs its bound actions. The hook's
`bindings.generated.json` is **projected from `BINDINGS`** by `bun run gen:hooks`
(`scripts/sync-hooks.ts`), and the events we register live in
`hooks/hooks/hooks.json` — so the wiring is defined once in the model and generated
outward, the same way the [hook-events.md](hook-events.md) "What we do" column is.

## What we wire today (the eleven)

Bound today: `SessionStart`, `UserPromptSubmit`, `PostToolUse`, `PostToolUseFailure`,
`Stop`, `StopFailure`, `SubagentStart`, `SubagentStop`, `PreCompact`, `PostCompact`,
`SessionEnd` — the events that carry the session record, kept lean to avoid per-event
Bun startup cost on the busy ones. The `flush-transcript-chunk` action is
*additionally* bound to the high-frequency turn events (`UserPromptSubmit`,
`PostToolUse`, `PostToolUseFailure`, `Stop`) and the final flush at `SessionEnd`.

`StopFailure`, `PreCompact`, and `PostCompact` are wired as lightweight marker-only
handlers: they let the corpus explain *why* a session's shape looks unusual
(turn-level API errors, context compaction) — which supports the `reconcile` path
for sessions that never fire a clean `SessionEnd`.

Expanding coverage = add the [action](actions.md) + a `BINDINGS` entry in the model,
register the event in `hooks.json`, then regenerate (`bun run gen:hooks` +
`gen:hook-events`). See the
[coverage note](hook-events.md#coverage-vs-what-we-wire-today) for the live count.

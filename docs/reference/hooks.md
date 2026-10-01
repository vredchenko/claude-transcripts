# Claude Code hook types

How Claude Code **hook events** map to **what we do** — kept deliberately separate
from the event catalogue itself. The behaviours are the [actions catalogue](actions.md),
bound to events via a composable **many-to-many mapping**
([ADR 0017](../design/decisions/0017-hooks-and-actions-decoupled.md)).

> **The event catalogue lives in [hook-events.md](hook-events.md)** — every Claude
> Code hook event, when it fires, its payload, example fixtures, and the action(s)
> we run. That table is **generated** from the app model
> ([`HOOK_TYPES`](../../packages/shared/src/model/hooks.ts)); this page narrates the
> binding model behind its "What we do" column. Don't maintain a second event list
> here. A *per-version* list is planned as `compatibility.json`
> ([compatibility.md](../start/compatibility.md), [ADR 0025](../design/decisions/0025-claude-code-compatibility-matrix.md));
> its generator is still a stub.

## Hooks → actions (the binding model)

A hook event doesn't hard-code a behaviour; it resolves to a **set of actions**:

- **[`HOOK_TYPES`](../../packages/shared/src/model/hooks.ts)** — the events (with
  `wired` marking the ones bound today).
- **[`ACTIONS`](../../packages/shared/src/model/actions.ts)** — the catalogue of
  event-handling behaviours, defined independently of any hook ([actions.md](actions.md)).
- **`BINDINGS`** (same file) — the many-to-many `event → actions[]` table.

`claude-transcripts hook run` (`packages/cli/src/hook/`) runs an event's bound
actions; the plugin's `hooks/scripts/dispatch.ts` just pipes the payload to it.
`hooks/hooks/hooks.json` is generated from `BINDINGS` (`bun run gen:hooks`), like the
[hook-events.md](hook-events.md) "What we do" column.

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

Expanding coverage = add a `HANDLERS` entry ([action](actions.md)) + a `BINDINGS`
entry, then `bun run gen:hooks && bun run gen:hook-events` (never hand-edit
`hooks.json`; CI diffs it). See the
[coverage note](hook-events.md#coverage-vs-what-we-wire-today) for the live count.

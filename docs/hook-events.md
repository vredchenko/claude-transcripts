<!-- GENERATED from the app model (@claude-transcripts/shared) by scripts/gen-hook-events.ts.
     Do NOT edit by hand — run `bun run gen:hook-events`. Edit the model:
     packages/shared/src/model/hooks.ts (events/order/summaries/ignoreReason) and
     actions.ts (the "What we do" bindings). -->

# Claude Code hook events — when they fire, payloads & fixtures

The authoritative catalogue of **every Claude Code hook event**, projected from the
app model ([`@claude-transcripts/shared` HOOK_TYPES](../packages/shared/src/model/hooks.ts)):
the one-line trigger for each, a link to the official documentation, links to
example **payload fixtures** under
[`tests/mock/claude-code/hooks/`](../tests/mock/claude-code/hooks/) (the inputs Claude Code sends a hook
on stdin — used for both these docs and test automation), and the action(s) we run.

This table is the **payload/fixture reference**. The complementary [hooks.md](hooks.md)
narrates the hook → action model, and [hook.md](hook.md) covers the writer
mechanics. The per-**version** authoritative list (which events each supported
Claude Code version exposes) is **generated** into `compatibility.json`
([compatibility.md](compatibility.md), [ADR 0025](decisions/0025-claude-code-compatibility-matrix.md))
— treat that as the source of truth if this table and a given CC version disagree.

- **Official reference:** <https://code.claude.com/docs/en/hooks>
- **Guide:** <https://code.claude.com/docs/en/hooks-guide>

## How to read this table

- **Fires when** — one-line trigger + what the event is for.
- **Docs** — deep link into the official hooks reference for that event.
- **Examples** — folder of example payload fixtures for that event (one or
  several JSON files; see [the fixtures README](../tests/mock/claude-code/hooks/README.md) for the
  naming/variety convention). Many are **placeholders today** — synthetic but
  shape-faithful — to be supplemented with real captures over time.
- **What we do** — for **wired** events, the action handlers bound to it (projected
  from the model's BINDINGS; [actions.md](actions.md) lists what each does). For
  **ignored** events, *why* we intentionally don't handle it. Both come from the
  model ([`hooks.ts`](../packages/shared/src/model/hooks.ts) +
  [`actions.ts`](../packages/shared/src/model/actions.ts)) — wire an ignored event
  by adding a binding and regenerating.

Events are ordered by **session lifecycle**: a session begins at the top and ends
(or crashes) at the bottom.

## Common payload fields

Every hook receives these on stdin; per-event fields are layered on top.

| Field | Type | Meaning |
|-------|------|---------|
| `session_id` | string | Claude Code's own session UUID — our stable key. |
| `transcript_path` | string | Absolute path to the session transcript (JSONL) on disk. |
| `cwd` | string | Working directory at the time the event fired. |
| `hook_event_name` | string | The event name (e.g. `PostToolUse`) — mirrors the row. |
| `permission_mode` | string? | Present on tool-related events (`default`, `plan`, …). |
| `effort` | object? | `{ "level": "low\|medium\|high\|…" }` when applicable. |

---

## Session start & setup

| Hook | Fires when | Docs | Examples | What we do |
|------|------------|------|----------|------------|
| `SessionStart` | A session begins, resumes, is cleared, or restarts after compaction — `source` ∈ `startup`/`resume`/`clear`/`compact`. The per-session entry point. | [ref](https://code.claude.com/docs/en/hooks#sessionstart) | [session-start/](../tests/mock/claude-code/hooks/session-start/) | `seed-session-start` · `write-event-marker` |
| `Setup` | The CLI runs in init/maintenance mode (e.g. `--init-only`) — one-time environment setup. | [ref](https://code.claude.com/docs/en/hooks#setup) | [setup/](../tests/mock/claude-code/hooks/setup/) | _ignored — Env/setup signal, not session activity._ |
| `InstructionsLoaded` | `CLAUDE.md` / `.claude/rules/*.md` instruction files are loaded — `load_reason` records why. Observability of which instructions applied. | [ref](https://code.claude.com/docs/en/hooks#instructionsloaded) | [instructions-loaded/](../tests/mock/claude-code/hooks/instructions-loaded/) | _ignored — Instruction-load audit — out of Tier-1 scope._ |

## Turn input

| Hook | Fires when | Docs | Examples | What we do |
|------|------------|------|----------|------------|
| `UserPromptSubmit` | The user submits a prompt, before Claude sees it. Can block or inject context. | [ref](https://code.claude.com/docs/en/hooks#userpromptsubmit) | [user-prompt-submit/](../tests/mock/claude-code/hooks/user-prompt-submit/) | `write-event-marker` · `update-counts` · `flush-transcript-chunk` |
| `UserPromptExpansion` | A slash command / skill prompt is expanded/templated before use. | [ref](https://code.claude.com/docs/en/hooks#userpromptexpansion) | [user-prompt-expansion/](../tests/mock/claude-code/hooks/user-prompt-expansion/) | _ignored — Slash-command expansion — redundant with `UserPromptSubmit`._ |

## Tool lifecycle

| Hook | Fires when | Docs | Examples | What we do |
|------|------------|------|----------|------------|
| `PreToolUse` | Before a tool executes — `tool_name` + `tool_input` available. Can block or modify the input. | [ref](https://code.claude.com/docs/en/hooks#pretooluse) | [pre-tool-use/](../tests/mock/claude-code/hooks/pre-tool-use/) | _ignored — Blocking pre-hook; an observe-only writer gains nothing — `PostToolUse` captures the outcome._ |
| `PermissionRequest` | A permission dialog is about to be shown for a tool call. | [ref](https://code.claude.com/docs/en/hooks#permissionrequest) | [permission-request/](../tests/mock/claude-code/hooks/permission-request/) | _ignored — Permission-dialog control hook, not session history._ |
| `PermissionDenied` | A tool call was denied (auto-classifier or user). | [ref](https://code.claude.com/docs/en/hooks#permissiondenied) | [permission-denied/](../tests/mock/claude-code/hooks/permission-denied/) | _ignored — Permission control event, not session history._ |
| `PostToolUse` | A tool succeeds — `tool_output` available. Can post-process the result. | [ref](https://code.claude.com/docs/en/hooks#posttooluse) | [post-tool-use/](../tests/mock/claude-code/hooks/post-tool-use/) | `write-event-marker` · `update-counts` · `flush-transcript-chunk` |
| `PostToolUseFailure` | A tool fails — `error_message` available. | [ref](https://code.claude.com/docs/en/hooks#posttoolusefailure) | [post-tool-use-failure/](../tests/mock/claude-code/hooks/post-tool-use-failure/) | `write-event-marker` · `update-counts` · `flush-transcript-chunk` |
| `PostToolBatch` | A batch of parallel tool calls resolves. | [ref](https://code.claude.com/docs/en/hooks#posttoolbatch) | [post-tool-batch/](../tests/mock/claude-code/hooks/post-tool-batch/) | _ignored — Batch boundary; the individual `PostToolUse` events are already captured._ |

## Subagents, teams & tasks

| Hook | Fires when | Docs | Examples | What we do |
|------|------------|------|----------|------------|
| `SubagentStart` | A subagent is spawned — `agent_type`, `agent_id`, `task_description`. | [ref](https://code.claude.com/docs/en/hooks#subagentstart) | [subagent-start/](../tests/mock/claude-code/hooks/subagent-start/) | `write-event-marker` · `update-counts` |
| `SubagentStop` | A subagent finishes — `summary` of its work. | [ref](https://code.claude.com/docs/en/hooks#subagentstop) | [subagent-stop/](../tests/mock/claude-code/hooks/subagent-stop/) | `write-event-marker` · `update-counts` |
| `TeammateIdle` | A team teammate goes idle. | [ref](https://code.claude.com/docs/en/hooks#teammateidle) | [teammate-idle/](../tests/mock/claude-code/hooks/teammate-idle/) | _ignored — Team orchestration, not session history._ |
| `TaskCreated` | A task is created via `TaskCreate`. | [ref](https://code.claude.com/docs/en/hooks#taskcreated) | [task-created/](../tests/mock/claude-code/hooks/task-created/) | _ignored — Task orchestration, not session history._ |
| `TaskCompleted` | A task is marked complete. | [ref](https://code.claude.com/docs/en/hooks#taskcompleted) | [task-completed/](../tests/mock/claude-code/hooks/task-completed/) | _ignored — Task orchestration, not session history._ |

## Display, MCP & notifications

| Hook | Fires when | Docs | Examples | What we do |
|------|------------|------|----------|------------|
| `MessageDisplay` | An assistant message is streamed/displayed to the user. | [ref](https://code.claude.com/docs/en/hooks#messagedisplay) | [message-display/](../tests/mock/claude-code/hooks/message-display/) | _ignored — UX event; the message content is already in the transcript._ |
| `Elicitation` | An MCP server requests user input. | [ref](https://code.claude.com/docs/en/hooks#elicitation) | [elicitation/](../tests/mock/claude-code/hooks/elicitation/) | _ignored — MCP interaction control hook; an observe-only writer gains nothing._ |
| `ElicitationResult` | The user responds to an elicitation. | [ref](https://code.claude.com/docs/en/hooks#elicitationresult) | [elicitation-result/](../tests/mock/claude-code/hooks/elicitation-result/) | _ignored — MCP interaction event; the content is in the transcript._ |
| `Notification` | Claude Code emits a notification (`permission_prompt`, `idle_prompt`, `auth_success`, …). | [ref](https://code.claude.com/docs/en/hooks#notification) | [notification/](../tests/mock/claude-code/hooks/notification/) | _ignored — UX notification, not session history._ |

## Environment, config & files

| Hook | Fires when | Docs | Examples | What we do |
|------|------------|------|----------|------------|
| `CwdChanged` | The working directory changes during a session. | [ref](https://code.claude.com/docs/en/hooks#cwdchanged) | [cwd-changed/](../tests/mock/claude-code/hooks/cwd-changed/) | _ignored — Host signal, out of session scope._ |
| `FileChanged` | A watched file changes on disk. | [ref](https://code.claude.com/docs/en/hooks#filechanged) | [file-changed/](../tests/mock/claude-code/hooks/file-changed/) | _ignored — Watcher signal, out of session scope._ |
| `ConfigChange` | A settings/config/skills file changes during the session (`user_settings`, `project_settings`, …). | [ref](https://code.claude.com/docs/en/hooks#configchange) | [config-change/](../tests/mock/claude-code/hooks/config-change/) | _ignored — Config-change signal, out of session scope._ |

## Worktrees

| Hook | Fires when | Docs | Examples | What we do |
|------|------------|------|----------|------------|
| `WorktreeCreate` | A git worktree is created (`--worktree`). | [ref](https://code.claude.com/docs/en/hooks#worktreecreate) | [worktree-create/](../tests/mock/claude-code/hooks/worktree-create/) | _ignored — Git-worktree lifecycle, irrelevant to session logging._ |
| `WorktreeRemove` | A git worktree is removed. | [ref](https://code.claude.com/docs/en/hooks#worktreeremove) | [worktree-remove/](../tests/mock/claude-code/hooks/worktree-remove/) | _ignored — Git-worktree lifecycle, irrelevant to session logging._ |

## Compaction

| Hook | Fires when | Docs | Examples | What we do |
|------|------------|------|----------|------------|
| `PreCompact` | Before context compaction — `trigger` ∈ `manual`/`auto`. | [ref](https://code.claude.com/docs/en/hooks#precompact) | [pre-compact/](../tests/mock/claude-code/hooks/pre-compact/) | `write-event-marker` |
| `PostCompact` | After compaction completes — `trigger` ∈ `manual`/`auto`. | [ref](https://code.claude.com/docs/en/hooks#postcompact) | [post-compact/](../tests/mock/claude-code/hooks/post-compact/) | `write-event-marker` |

## Turn end

| Hook | Fires when | Docs | Examples | What we do |
|------|------------|------|----------|------------|
| `Stop` | Claude finishes responding to a turn — `turn_number`, `assistant_message`. | [ref](https://code.claude.com/docs/en/hooks#stop) | [stop/](../tests/mock/claude-code/hooks/stop/) | `write-event-marker` · `flush-transcript-chunk` |
| `StopFailure` | A turn ends with an API error — `rate_limit`, `overloaded`, `max_output_tokens`, … A turn-level failure (see the crash note in the doc). | [ref](https://code.claude.com/docs/en/hooks#stopfailure) | [stop-failure/](../tests/mock/claude-code/hooks/stop-failure/) | `write-event-marker` · `update-counts` |

## Session end

| Hook | Fires when | Docs | Examples | What we do |
|------|------------|------|----------|------------|
| `SessionEnd` | The session terminates — `reason` ∈ `clear`/`resume`/`logout`/`prompt_input_exit`/`bypass_permissions_disabled`/`other`. | [ref](https://code.claude.com/docs/en/hooks#sessionend) | [session-end/](../tests/mock/claude-code/hooks/session-end/) | `flush-transcript-chunk` · `write-summary` · `upload-blobs` |

> **On crashes.** There is **no dedicated "session crashed" event**. Abnormal
> termination surfaces in three ways, in increasing severity:
> 1. `StopFailure` — the turn hit an API/runtime error but the session is alive.
> 2. `SessionEnd` with `reason: "other"` — an orderly-but-non-standard shutdown.
> 3. **No `SessionEnd` at all** — a hard crash / kill. The session is then
>    detected as **`incomplete`** by derivation (see
>    [couchdb.md → status model](couchdb.md#status-model-derived-not-stored)) and
>    finalised by the `reconcile` utility ([tools.md](tools.md)). Fixtures for (1)
>    and (2) live under `stop-failure/` and `session-end/`; case (3) is exercised
>    by leaving a started session with no end fixture.

## Coverage vs. what we wire today

We currently bind actions to **11** of the 30 events —
`SessionStart`, `UserPromptSubmit`, `PostToolUse`, `PostToolUseFailure`, `SubagentStart`, `SubagentStop`, `PreCompact`, `PostCompact`, `Stop`, `StopFailure`, `SessionEnd`. The rest are **intentionally ignored** — the "What we do" column gives
the reason per event: a passive, observe-only writer gains nothing from
blocking / UX / orchestration hooks, and every hook invocation costs a Bun startup,
so we wire only the events that carry the session record ([hooks.md](hooks.md)).
Wiring an ignored event = add the [action](actions.md) + binding in the model and
register it in `hooks.json` (regenerated by `bun run gen:hooks`).

> **Field-shape caveat.** Payload field names/casing follow the official reference
> at authoring time. Claude Code is upstream and evolving; when in doubt, capture a
> real payload (every hook just receives JSON on stdin — `… | tee fixture.json`)
> and reconcile against `compatibility.json`.

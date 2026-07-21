import type { HookTypeDef } from "./types";

/**
 * Canonical Claude Code hook types (the codebase-side source of truth). Goal: a
 * handler for every hook CC exposes; `wired` marks the ones bound today, and
 * `ignoreReason` records *why* an unwired event is intentionally not handled (the
 * hook-events doc renders it). The authoritative per-version list is generated into
 * compatibility.json; a drift check diffs this against it.
 *
 * Order is **lifecycle order** (session opens at the top, closes at the bottom);
 * `category` groups the events and the hooks doc (gen-hook-events) renders sections
 * in this order. `summary` is the one-line "fires when" used verbatim by the doc.
 */
export const HOOK_TYPES: HookTypeDef[] = [
  // ── Session start & setup ──
  {
    event: "SessionStart",
    category: "session-start",
    canBlock: false,
    wired: true,
    summary:
      "A session begins, resumes, is cleared, or restarts after compaction — `source` ∈ `startup`/`resume`/`clear`/`compact`. The per-session entry point.",
  },
  {
    event: "Setup",
    category: "session-start",
    canBlock: false,
    wired: false,
    ignoreReason: "Env/setup signal, not session activity.",
    summary:
      "The CLI runs in init/maintenance mode (e.g. `--init-only`) — one-time environment setup.",
  },
  {
    event: "InstructionsLoaded",
    category: "session-start",
    canBlock: false,
    wired: false,
    ignoreReason: "Instruction-load audit — out of Tier-1 scope.",
    summary:
      "`CLAUDE.md` / `.claude/rules/*.md` instruction files are loaded — `load_reason` records why. Observability of which instructions applied.",
  },
  // ── Turn input ──
  {
    event: "UserPromptSubmit",
    category: "turn-input",
    canBlock: true,
    wired: true,
    summary: "The user submits a prompt, before Claude sees it. Can block or inject context.",
  },
  {
    event: "UserPromptExpansion",
    category: "turn-input",
    canBlock: true,
    wired: false,
    ignoreReason: "Slash-command expansion — redundant with `UserPromptSubmit`.",
    summary: "A slash command / skill prompt is expanded/templated before use.",
  },
  // ── Tool lifecycle ──
  {
    event: "PreToolUse",
    category: "tool",
    canBlock: true,
    wired: false,
    ignoreReason:
      "Blocking pre-hook; an observe-only writer gains nothing — `PostToolUse` captures the outcome.",
    summary:
      "Before a tool executes — `tool_name` + `tool_input` available. Can block or modify the input.",
  },
  {
    event: "PermissionRequest",
    category: "tool",
    canBlock: true,
    wired: false,
    ignoreReason: "Permission-dialog control hook, not session history.",
    summary: "A permission dialog is about to be shown for a tool call.",
  },
  {
    event: "PermissionDenied",
    category: "tool",
    canBlock: false,
    wired: false,
    ignoreReason: "Permission control event, not session history.",
    summary: "A tool call was denied (auto-classifier or user).",
  },
  {
    event: "PostToolUse",
    category: "tool",
    canBlock: false,
    wired: true,
    summary: "A tool succeeds — `tool_output` available. Can post-process the result.",
  },
  {
    event: "PostToolUseFailure",
    category: "tool",
    canBlock: false,
    wired: true,
    summary: "A tool fails — `error_message` available.",
  },
  {
    event: "PostToolBatch",
    category: "tool",
    canBlock: true,
    wired: false,
    ignoreReason: "Batch boundary; the individual `PostToolUse` events are already captured.",
    summary: "A batch of parallel tool calls resolves.",
  },
  // ── Subagents, teams & tasks ──
  {
    event: "SubagentStart",
    category: "subagent",
    canBlock: false,
    wired: true,
    summary: "A subagent is spawned — `agent_type`, `agent_id`, `task_description`.",
  },
  {
    event: "SubagentStop",
    category: "subagent",
    canBlock: true,
    wired: true,
    summary: "A subagent finishes — `summary` of its work.",
  },
  {
    event: "TeammateIdle",
    category: "subagent",
    canBlock: true,
    wired: false,
    ignoreReason: "Team orchestration, not session history.",
    summary: "A team teammate goes idle.",
  },
  {
    event: "TaskCreated",
    category: "subagent",
    canBlock: true,
    wired: false,
    ignoreReason: "Task orchestration, not session history.",
    summary: "A task is created via `TaskCreate`.",
  },
  {
    event: "TaskCompleted",
    category: "subagent",
    canBlock: true,
    wired: false,
    ignoreReason: "Task orchestration, not session history.",
    summary: "A task is marked complete.",
  },
  // ── Display, MCP & notifications ──
  {
    event: "MessageDisplay",
    category: "display",
    canBlock: false,
    wired: false,
    ignoreReason: "UX event; the message content is already in the transcript.",
    summary: "An assistant message is streamed/displayed to the user.",
  },
  {
    event: "Elicitation",
    category: "display",
    canBlock: true,
    wired: false,
    ignoreReason: "MCP interaction control hook; an observe-only writer gains nothing.",
    summary: "An MCP server requests user input.",
  },
  {
    event: "ElicitationResult",
    category: "display",
    canBlock: true,
    wired: false,
    ignoreReason: "MCP interaction event; the content is in the transcript.",
    summary: "The user responds to an elicitation.",
  },
  {
    event: "Notification",
    category: "display",
    canBlock: false,
    wired: false,
    ignoreReason: "UX notification, not session history.",
    summary:
      "Claude Code emits a notification (`permission_prompt`, `idle_prompt`, `auth_success`, …).",
  },
  // ── Environment, config & files ──
  {
    event: "CwdChanged",
    category: "environment",
    canBlock: false,
    wired: false,
    ignoreReason: "Host signal, out of session scope.",
    summary: "The working directory changes during a session.",
  },
  {
    event: "FileChanged",
    category: "environment",
    canBlock: false,
    wired: false,
    ignoreReason: "Watcher signal, out of session scope.",
    summary: "A watched file changes on disk.",
  },
  {
    event: "ConfigChange",
    category: "environment",
    canBlock: true,
    wired: false,
    ignoreReason: "Config-change signal, out of session scope.",
    summary:
      "A settings/config/skills file changes during the session (`user_settings`, `project_settings`, …).",
  },
  // ── Worktrees ──
  {
    event: "WorktreeCreate",
    category: "worktree",
    canBlock: true,
    wired: false,
    ignoreReason: "Git-worktree lifecycle, irrelevant to session logging.",
    summary: "A git worktree is created (`--worktree`).",
  },
  {
    event: "WorktreeRemove",
    category: "worktree",
    canBlock: false,
    wired: false,
    ignoreReason: "Git-worktree lifecycle, irrelevant to session logging.",
    summary: "A git worktree is removed.",
  },
  // ── Compaction ──
  {
    event: "PreCompact",
    category: "compaction",
    canBlock: true,
    wired: true,
    summary: "Before context compaction — `trigger` ∈ `manual`/`auto`.",
  },
  {
    event: "PostCompact",
    category: "compaction",
    canBlock: false,
    wired: true,
    summary: "After compaction completes — `trigger` ∈ `manual`/`auto`.",
  },
  // ── Turn end ──
  {
    event: "Stop",
    category: "turn-end",
    canBlock: true,
    wired: true,
    summary: "Claude finishes responding to a turn — `turn_number`, `assistant_message`.",
  },
  {
    event: "StopFailure",
    category: "turn-end",
    canBlock: false,
    wired: true,
    summary:
      "A turn ends with an API error — `rate_limit`, `overloaded`, `max_output_tokens`, … A turn-level failure (see the crash note in the doc).",
  },
  // ── Session end ──
  {
    event: "SessionEnd",
    category: "session-end",
    canBlock: false,
    wired: true,
    summary:
      "The session terminates — `reason` ∈ `clear`/`resume`/`logout`/`prompt_input_exit`/`bypass_permissions_disabled`/`other`.",
  },
];

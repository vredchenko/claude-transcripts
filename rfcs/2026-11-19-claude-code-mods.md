# Claude Code mods: what they could do for the plugin

**Date:** 2026-11-19
**Status:** Proposed. A research item, not yet a design.

## Why this exists

Claude Code now has **mods**: plugins that ship a TypeScript hooks module (named under
`modules` in `hooks/hooks.json`) and run function hooks against an engine interface
(`$`). They can draw UI, such as panes, rows above the prompt, decorations on tool calls
and subagent rows (`AgentRow`), status entries and toasts. They can also hook tool calls,
prompts, the system prompt and session events, and register slash commands, tools and
agent types.

Claude Code points to mods as the replacement for `subagentStatusLine`, which the plugin
dropped in [#295](https://github.com/vredchenko/claude-transcripts/issues/295). The
feature is broad enough to deserve a deliberate look rather than a one-off port.

## Questions to answer

- **Fit.** Which of the plugin's jobs would be better as function hooks than as command
  hooks and settings? Candidates: the recording indicator (per-subagent rows, a status
  entry), a history or recall pane beside the chat, and recall offered as a tool instead
  of a skill.
- **Writer boundary.** Could a mod observe events (`session.append`, `turn.complete`)
  more completely than the command hooks do? If it could, would that change who the writer
  is? Writes must still go through the webapi
  ([ADR 0016](../docs/design/decisions/0016-webapi-is-the-io-gateway.md)), and there
  must still be one writer.
- **Packaging and compatibility.** How does a Claude Code version without mod support
  handle a `hooks.json` that names `modules`? Should a mod ship inside this plugin or as
  a separate, optional one?
- **Stability.** Claude Code describes the API as early access and changes it between
  releases. What would pinning to it cost, and how would we test it (`claude plugin
  validate`, `claude plugin test`)?
- **One implementation.** A mod reaches files and processes only through `$`. Rendering
  status from a mod must not create a second copy of the state format the CLI owns.

## Outcome

Write an ADR covering whether and how the project uses mods, then file the concrete
features it chooses as issues.

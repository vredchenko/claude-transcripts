# Actions and bindings

An **action** is one behaviour the hook performs. Actions are defined independently of
hook events and bound to them many-to-many
([ADR 0017](../design/decisions/0017-hooks-and-actions-decoupled.md)), all in the app
model:

- `HOOK_TYPES` (`packages/shared/src/blueprint/hooks.ts`) — every Claude Code hook event;
  `wired` marks the bound ones and `ignoreReason` says why the rest aren't.
- `ACTIONS` and `BINDINGS` (`packages/shared/src/blueprint/actions.ts`) — the catalogue and
  the `event → actions[]` table.
- `HANDLERS` (`packages/cli/src/hook/handlers.ts`) — one implementation per action.

The current event → actions table is generated into [hook-events.md](hook-events.md)
("What we do").

## Catalogue

| Action | Does | Writes |
|--------|------|--------|
| `write-event-marker` | Append a small `type: "event"` doc for the event | CouchDB |
| `update-counts` | Bump per-session counters (events, prompts, errors, tools) | `/tmp` |
| `flush-transcript-chunk` | Tail the transcript into `chunk` docs, batched by size and time ([mid-flight-chunking.md](../design/mid-flight-chunking.md)) | CouchDB |
| `write-summary` | At session end, compute the rollup and token usage and write `summary:<id>` (plus `summary.json` in S3 when blobs are on) | CouchDB, S3 |
| `upload-blobs` | Upload the byte-exact `transcript.jsonl` | S3 |
| `seed-session-start` | Reset counters and chunk offset; record the resolved targets and last-write time for the statusline | `/tmp`, CouchDB |
| `inject-recall-policy` | Prime the session with the recall policy and how much history this directory has; omitted when recall is off, the directory is excluded or empty, or the webapi is slow ([ADR 0029](../design/decisions/0029-recall-policy-config-driven-session-start.md)) | stdout (context) |
| `announce-recording` | Print the session-start banner: where the session is recorded, or that it isn't. The only action that writes to stdout. | stdout (transcript) |

Planned, with no handler yet: `enrich-metadata` (post host and harness metadata),
`extract-feature` (URLs, repos, PRs, slash commands, models), `detect-memory-write`
(`Edit`/`Write` to memory files, `CLAUDE.md`, `AGENTS.md`), `app-log`
([app-logging.md](../operate/app-logging.md)), `index-for-search` (search indexing
already happens in the webapi's change follower), `reconcile-session` (finalise a
session that never ended).

## What is wired

Eleven events: `SessionStart`, `UserPromptSubmit`, `PostToolUse`, `PostToolUseFailure`,
`Stop`, `StopFailure`, `SubagentStart`, `SubagentStop`, `PreCompact`, `PostCompact`,
`SessionEnd`. `flush-transcript-chunk` runs on the turn events (`UserPromptSubmit`,
`PostToolUse`, `PostToolUseFailure`, `Stop`) and a final flush at `SessionEnd`.
`StopFailure`, `PreCompact` and `PostCompact` only write markers, which explain sessions
with an unusual shape (API errors, compaction).

## Adding behaviour

Add an action to `ACTIONS`, a handler to `HANDLERS` and a row to `BINDINGS`, then run
`bun run gen:hooks && bun run gen:hook-events`. Never hand-edit `hooks.json`. Rules:

- Actions observe; they never block or alter a session.
- Actions fail independently: one throwing doesn't stop the others bound to the same
  event (`Promise.allSettled`).
- Only `SessionStart` actions write to stdout. On `UserPromptSubmit` stdout would be
  injected into the session as context; on most other events it goes to Claude Code's
  debug log. `SessionStart` stays synchronous so its output arrives
  ([hook.md](hook.md#dispatch)).

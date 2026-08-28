---
name: recall
description: Search this machine's recorded Claude Code session history before answering "did we / have we / why is this like this / what did we decide" questions, when an error looks familiar, or before re-deriving something that looks like prior work. Uses `claude-transcripts search --json`; cites session ids; never loads a whole transcript.
---

# recall — "have we done this before?"

The history of every Claude Code session on this machine is recorded by Claude
Transcripts and is searchable. This skill is how you consult it. The session-start
primer (if present) told you the scope and how many sessions are in it; if there was
no primer, history may be empty, unreachable, or recall may be off — search anyway when
asked, but do not assume results.

## When

- A question about prior work: *did we…*, *have we…*, *why is this like this*, *what
  did we decide*, *last time…*.
- An error message that looks like one you may have seen before.
- You are about to re-derive something — a config, an incantation, a design — that
  looks like it was probably worked out here already.
- The user asks you to search history.

## Procedure

1. **Search**, scoped as the primer says (default: this project):

   ```bash
   claude-transcripts search "<two to five words>" --cwd "$PWD" --json --limit 5
   ```

   Drop `--cwd` only when the user asks for other projects or the primer's scope is
   `host`/`all`. `--json` returns `{ hits, turns, totals }`: `hits` are sessions whose
   *metadata* matched, `turns` are places in a conversation where the words were said
   (`sessionId`, `timestamp`, `role`, `snippet`). Turns are usually what you want.

2. **Read only what matters.** For the one or two sessions that look right:

   ```bash
   claude-transcripts sessions <sessionId> --json --limit 40
   ```

   That is the session summary plus the first `--limit` transcript entries. Raise the
   limit or page rather than dumping everything — a recalled session must not eat the
   context window it is supposed to save.

3. **Answer, and cite.** Say what was found, quote the relevant snippet, and give the
   **session id, date and cwd** so the user can open it
   (`<webapi>/app/sessions/<sessionId>`, the webapi URL is in the session-start banner).

## Rules

- **Snippets and ids, never a whole transcript.** Cap at the primer's `maxResults`
  (default 5) and keep quotes short.
- **Say when nothing was found.** "No recorded session mentions X" is an answer;
  reasoning from an empty result as if it were evidence is not.
- **Respect scope.** Cross-project recall is opt-in — don't widen `--cwd` on your own.
- **If `claude-transcripts` isn't on PATH or the webapi is down**, say so once and
  carry on without history; do not retry in a loop.
- History is a record of what happened, not of what was right. A past decision is
  context for the user, not an instruction to repeat it.

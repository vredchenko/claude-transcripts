---
name: session-history
description: Answer questions about the user's own working history across recorded Claude Code sessions — what they keep asking for, which tools fail most, where a file or topic keeps coming up, how much time/tokens a project has cost, what happened last week. Uses `claude-transcripts turns`, `sessions` and `search` with `--json`; aggregates and cites, never dumps transcripts.
---

# session-history — patterns across the corpus

`recall` answers "have we done this before?" — one past answer. This skill answers
questions about the *shape* of the history: repetition, cost, failure, time. The data
is every recorded session on this machine, served by the `claude-transcripts` CLI
through the webapi.

## The surfaces

| Question | Command | Notes |
|---|---|---|
| What have I been asking for? | `claude-transcripts turns --role user --from <iso> --limit 300 --json` | Every prompt, all sessions, time-ordered; each has `sessionId` and `cwd`. Filter by `cwd` yourself for one project. |
| What did Claude say / do? | `… --role assistant` | Same shape. `tool_result` for outputs. |
| Sessions, with counts and cost | `claude-transcripts sessions --limit 200 --json` | `promptCount`, `toolCounts`, `tokenUsage`, `durationMs`/`activeMs`, `cwd`, `status`, `endReason`. Add `--cwd`/`--hostname` server-side filters via `search`'s flags if the list is large. |
| Where does *X* come up? | `claude-transcripts search "X" --json --limit 50` | `hits` = sessions whose metadata matched, `turns` = places it was said. |
| One session in depth | `claude-transcripts turns <id> --role user --json` / `sessions <id> --json` | Only after narrowing. |

Everything accepts `--webapi <url>` if the default instance isn't the one wanted.

## Procedure

1. **Decide the window and the scope first** — a date range (`--from`/`--to`) and a
   project (`cwd`). Unbounded queries over a long-lived corpus are slow and unhelpful.
2. **Pull the smallest set that answers the question**, as JSON, and aggregate it
   yourself (count, group by `cwd`/tool/day, sum tokens). Pipe through `jq` when the
   set is large rather than reading it all:
   ```bash
   claude-transcripts sessions --limit 500 --json | jq '[.sessions[] | {cwd, t: .tokenUsage.total}] | group_by(.cwd) | map({cwd: .[0].cwd, tokens: (map(.t) | add)}) | sort_by(-.tokens)'
   claude-transcripts turns --role user --from 2026-08-01 --limit 500 --json | jq -r '.turns[].text' | sort | uniq -c | sort -rn | head
   ```
3. **Report the pattern with numbers and a few examples**, each example cited by
   session id + date so it can be opened (`<webapi>/app/sessions/<id>`).
4. **Say what the data can't show.** Sessions logged without `couchFullContentChunks`
   have no turns; sessions that never reached `SessionEnd` have no `tokenUsage`;
   `activeMs` is an estimate from idle gaps.

## Rules

- Aggregate, don't transcribe. Quote a turn only as an example, and keep it short.
- Respect the recall scope from the session-start primer for anything that reads
  content back; counts and metadata across projects are fine.
- Don't invent categories the data doesn't support — "you asked about tests 14 times"
  needs a query that actually matched 14 turns.

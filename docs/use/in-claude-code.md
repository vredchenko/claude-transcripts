# In Claude Code

Once the hook is installed, recording asks nothing of you. This page covers what you
see while it works, what each indicator means, and how Claude reads your history back.

## At session start

A new session opens with a note saying where it is being recorded:

```
● Claude Transcripts recording → claude-transcripts-sessions@127.0.0.1:7652 (+ s3://claude-transcripts-sessions)
  http://127.0.0.1:7650/app/sessions/<session_id>
```

The second line is this session in [the web UI](web-ui.md). When the machine is not
recording, the note says so, and why:

```
○ Claude Transcripts not recording — no instance configured. Run claude-transcripts install.
○ Claude Transcripts NOT recording — <host>: <reason>
```

The second form means an instance is configured but is down, or up with its stores
unavailable.

Under the note, one line reports whether the running Claude Code still fires the hook
events this build was made for, or a short summary of what changed
([compatibility](../start/compatibility.md)):

```
✓ Hook spec matches Claude Code 2.1.310 (33 events, 11 recorded)
```

## The statusline

The statusline carries the same answer continuously, so you don't have to remember the
note:

| It shows | Meaning |
|----------|---------|
| `● ct@v0.2.0 rec · 128 ev · 6 tools · 2s ago → …` | Writes are landing. |
| `● … rec (mirror) …` | Only a [mirror](../operate/mirrors.md) is taking them. |
| `◌ ct@v0.2.0 ready · … · no write yet → …` | Configured; the first write has not landed yet. |
| `◐ ct@v0.2.0 stalled …` | The instance has stopped accepting writes. The line names why (`HTTP 503`, `timeout`, `unreachable`) and the command that recovers the gap. |
| `◐ ct@v0.2.0 stalled · hook silent …` | The session's transcript keeps growing but the hook hasn't run in over five minutes. |
| `○ ct@v0.2.0 off · no instance configured` | There is nothing to record to. |
| `○ ct@v0.2.0 off · not recording this session` | This session is not being recorded. |

- The version is the recording binary's own (`ct@dev` from a checkout), so a machine
  running a stale hook says so on every refresh.
- The state is coloured (set `NO_COLOR` to turn that off), and the store name links to
  the session in the web UI.
- On a narrow terminal the line drops detail instead of wrapping.
- It makes no network calls: it reads what the hook last recorded locally.

`install` registers it (`--no-statusline` opts out). A `statusLine` you already have is
never overwritten; `claude-transcripts statusline install` prints how to combine the
two.

## When a write doesn't land

The hook never blocks or fails a session: every write is time-boxed, and a broken
recorder shows up in the indicators above, not as an error in your work.

Nothing is queued locally either. Claude Code's own transcript on disk is the buffer,
and [`claude-transcripts backfill`](../operate/tools.md) rebuilds any gap from it once
the instance is back. To see what is wrong:

```bash
claude-transcripts hook status   # what is registered, and whether its target takes writes
claude-transcripts doctor        # write a synthetic session, read it back, search it
```

More in [the hook reference](../reference/hook.md#when-a-write-fails).

## Recall: Claude reads the history back

At the start of a session in a directory that already has recorded sessions, Claude is
told that history exists, how to search it, and the rules for using it:

```
Session history for this project is available via `claude-transcripts search`.
This directory has 37 recorded sessions, most recent 2 days ago.
Before answering a question about why existing code is the way it is, or before
re-deriving something that looks like prior work here, search history first.
Cite the session id and date. Scope: this project. Max 5 results, snippets only.
```

So a question like "why is this written this way?" or an error you have met before can
be answered from what was actually said, with the session id and date to check it
against. Whole transcripts are never pulled into the session, only snippets.

The policy is the `recall` section of the instance
[settings](../start/configuration.md#settings):

| Key | Values | Default |
|-----|--------|---------|
| `mode` | `off` never; `suggest` proposes a search and lets you confirm; `auto` just searches | `auto` |
| `scope` | `project` (this directory), `host`, `all` | `project` |
| `maxResults`, `maxSnippetChars` | how much comes back | `5`, `400` |
| `excludeCwdGlobs` | directories recall never touches | none |

The note is left out when `mode` is `off`, the directory is excluded, nothing has been
recorded there, or the instance doesn't answer in time.

Recall reads past sessions into the current one, so widen `scope` deliberately:
transcripts can contain secrets, and nothing masks them yet.

## With the plugin

`claude-transcripts install` registers the hook and the statusline directly. Installing
through Claude Code's plugin mechanism instead
([which to pick](../start/installation.md#registering-the-hook-binary-or-plugin)) adds:

- **`/claude-transcripts:status`**: hook registration, the instance and whether it
  takes writes, search state, this session's id and link, and what to run if something
  is wrong.
- **Skills**, which load only when a conversation calls for them:
  - `recall` answers "have we done this before?" by searching, opening the one or two
    sessions that matter, and citing them.
  - `session-history` looks for patterns across sessions: what you keep asking for,
    which tools fail, where a topic recurs, cost and time per project.
  - `transcripts-admin` maps each statusline state to its fix, and walks through
    backup and restore, migrations, reindexing, backfill, upgrade and uninstall.

The plugin's own options (`recall_mode`, `recall_scope`, `max_results`) override the
instance's recall policy for you alone.

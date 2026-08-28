# hooks/ — the Claude Code plugin

The Claude Code plugin: it routes hook events to the installed `claude-transcripts`
CLI (the writer), and it makes the recording **visible** — a session-start banner, a
statusline indicator, and a `/claude-transcripts:status` command.

**There is no logging code here.** `scripts/dispatch.ts` reads the hook payload on
stdin and pipes it to `claude-transcripts hook run` — the same command
`claude-transcripts hook install` registers directly. The statusline wrapper does the
same for `claude-transcripts statusline render`. One implementation, one place to
change it.

## Install

The repo is its own marketplace (`.claude-plugin/marketplace.json`):

```
/plugin marketplace add vredchenko/claude-transcripts
/plugin install claude-transcripts@claude-transcripts
```

It still needs the CLI installed (`claude-transcripts install`, or the binaries on the
releases page) — that is what does the work.

## What you see

- **At session start**, a line in the transcript:
  `Claude Transcripts — recording to couchdb://…/claude-transcripts-sessions + s3://… · http://127.0.0.1:7650/app/sessions/<id>`
  — or, with no instance configured, `Claude Transcripts — not recording …`. A silent
  hook and a broken hook used to look identical; this is the fix.
- **In the statusline**, continuously: `● ct rec · 128 ev · 6 tools · 2s ago → …`,
  `◐ ct stalled …` when the store has stopped accepting writes, `○ ct off` when there
  is nothing to record to. Rendered from the hook's own scratch files — no network.
  A plugin may set `subagentStatusLine` (done, in `settings.json`) but not the main
  `statusLine`, so that one is registered by `claude-transcripts statusline install`
  (`install` does it for you; `--no-statusline` opts out). An existing `statusLine`
  of yours is never overwritten.
- **On demand**: `/claude-transcripts:status` — hook registration, stores, this
  session's id and link, and what to run if something is wrong.

## Why it used to be more than this

The plugin previously carried a **second, parallel writer**: its own handlers, its own
CouchDB and S3 clients, and copies of `sumTranscriptTokens` and the chunking helpers
kept *byte-identical* with `@claude-transcripts/shared` by hand. That existed for one
real reason — a plugin directory can't resolve the workspace, so it couldn't import the
shared code.

Once the CLI became the registered hook, that reason expired: an installed binary
resolves everything itself. The copies were retired along with the
"keep these two files identical" rule and the drift risk it carried.

## Layout

- `.claude-plugin/plugin.json` — plugin manifest.
- `hooks/hooks/hooks.json` — the Claude Code events to register (**generated** by
  `scripts/sync-hooks.ts`, `bun run gen:hooks`; re-run after changing the model's
  `BINDINGS`).
- `scripts/dispatch.ts` — the shim. Finds the CLI (PATH, then the installer's
  `~/.local/bin`, then `CT_HOME`), forwards the payload, and **always exits 0** —
  a missing or broken CLI must never turn into a failed hook.
- `bin/claude-transcripts-statusline` — the statusline wrapper (a plugin's `bin/` is
  on PATH). Same resolution as the shim; prints `○ ct off` if the CLI is missing.
- `settings.json` — `subagentStatusLine`, the one setting a plugin may carry.
- `commands/status.md` — `/claude-transcripts:status`.

## Where this is going

[docs/design/plugin.md](../docs/design/plugin.md) is the plan; the visibility half
above is built. Next: **skills** that let Claude read the corpus back (`recall`), and
a recall policy in `config/` that says when to consult history unprompted.

## Which install path to use

`claude-transcripts hook install` is the normal one: it registers the binary with
Claude Code directly and needs no plugin, no Bun and no checkout
([installation.md](../docs/design/installation.md)). This plugin is for people who
prefer Claude Code's plugin mechanism; it still requires the CLI to be installed,
because that's what does the work.

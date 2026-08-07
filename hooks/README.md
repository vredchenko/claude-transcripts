# hooks/ — the Claude Code plugin

A thin plugin wrapper that routes Claude Code's hook events to the installed
`claude-transcripts` CLI. The CLI is the writer; this directory only exists so the
project can also be installed the way Claude Code installs plugins.

**There is no logging code here.** `scripts/dispatch.ts` reads the hook payload on
stdin and pipes it to `claude-transcripts hook run` — the same command
`claude-transcripts hook install` registers directly. One implementation, one place to
change it.

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
- `hooks/hooks.json` — the Claude Code events to register (**generated** by
  `scripts/sync-hooks.ts`, `bun run gen:hooks`; re-run after changing the model's
  `BINDINGS`).
- `scripts/dispatch.ts` — the shim. Finds the CLI (PATH, then the installer's
  `~/.local/bin`, then `CT_HOME`), forwards the payload, and **always exits 0** —
  a missing or broken CLI must never turn into a failed hook.

## Which install path to use

`claude-transcripts hook install` is the normal one: it registers the binary with
Claude Code directly and needs no plugin, no Bun and no checkout
([installation.md](../docs/design/installation.md)). This plugin is for people who
prefer Claude Code's plugin mechanism; it still requires the CLI to be installed,
because that's what does the work.

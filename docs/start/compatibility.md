# Claude Code compatibility

Claude Transcripts is a set of Claude Code hooks, so it depends on which hook events
Claude Code fires and what their payloads carry — and both change between releases.
Every session checks this for you, and `claude-transcripts compat` checks it on demand
([ADR 0025](../design/decisions/0025-claude-code-compatibility-matrix.md)).

## The check at session start

The session-start banner ends with one line when all is well:

```
● Claude Transcripts recording → claude-transcripts-sessions@localhost
✓ Hook spec matches Claude Code 2.1.310 (33 events, 11 recorded)
```

and a short summary when it isn't:

```
△ Hook spec drift with Claude Code 2.1.310:
  · new events we don't handle: DirectoryAdded, PostModelSwitch, PreModelSwitch
  · Stop: +last_assistant_message −turn_number
  Details: claude-transcripts compat
```

| Line | Meaning |
|------|---------|
| recorded, but no longer fired | An event we record is gone. **History is being lost** — upgrade Claude Transcripts. |
| new events we don't handle | Claude Code added events our catalogue doesn't list. Nothing breaks; they just aren't recorded. |
| listed, but no longer fired | An event we list (but don't record) is gone. Cosmetic. |
| `<Event>: +field −field` | Payload fields (or `field=value` values) that changed, on events we record, since the version this build was checked against. `common fields` are the ones every event carries. |
| `? … not checked yet` | This build doesn't ship the spec for your Claude Code version. It is fetched in the background; the next session shows the result. |

The check is skipped after a compaction (same session, same binary). It never delays
the session: the comparison is local, and the one network fetch runs detached.

## Where the spec comes from

Every Claude Code release ships a matching release of
[`@anthropic-ai/claude-agent-sdk`](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk)
on npm. Its `package.json` names the Claude Code version (`claudeCodeVersion`), and its
`sdk.d.ts` declares `HOOK_EVENTS` and one `<Event>HookInput` type per event. A published
npm version can't change, so this is an exact, reproducible answer for each Claude Code
version — unlike the prose docs, which only describe the latest one.

- **The running version** is `claude --version` (a hook payload carries none).
- **The spec this build was checked against** is generated into
  `packages/shared/src/claude-code-hook-spec.json` by `bun run gen:compat` and ships in
  the CLI. It pins one Claude Code version, so regenerating it is reproducible;
  `bun run gen:compat --latest` moves the pin.
- **Any other version's spec** is fetched from the npm registry (honouring
  `NPM_CONFIG_REGISTRY`), checked against the registry's sha512 integrity, and cached in
  `<data dir>/claude-code-specs/<version>.json`.

## On demand

```
claude-transcripts compat                         # the installed Claude Code
claude-transcripts compat --cc-version 2.1.250    # any released version
claude-transcripts compat --json                  # the full report
```

It exits `0` when in step, `1` on drift, `2` when no spec could be had (offline, or a
version with no SDK release).

## Not yet

- **A verified version range.** There is no `earliestCompatible`/`latestCompatible`
  yet; that needs the e2e suite run against several Claude Code versions.
- **Fields we read.** The field check compares payloads between Claude Code versions.
  It doesn't yet know which fields our handlers depend on, so a removed field is
  reported whether or not we read it.

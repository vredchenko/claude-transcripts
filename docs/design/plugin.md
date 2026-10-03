# The Claude Code plugin

`hooks/` is a Claude Code plugin that does three things beyond pointing Claude Code at
the writer: it shows that a session is being recorded and where, gives Claude skills
for reading history back, and carries the policy that tells Claude when to look without
being asked. Usage: [`hooks/README.md`](../../hooks/README.md).

```
.claude-plugin/marketplace.json        the repo is its own marketplace
hooks/
├── .claude-plugin/plugin.json         manifest: commands, skills, userConfig
├── hooks/hooks.json                   generated from BINDINGS (bun run gen:hooks)
├── scripts/dispatch.ts                shim → claude-transcripts hook run
├── settings.json                      subagentStatusLine
├── bin/claude-transcripts-statusline  statusline renderer (a plugin's bin/ is on PATH)
├── commands/status.md                 /claude-transcripts:status
└── skills/{recall,session-history,transcripts-admin}/SKILL.md
```

Install with `/plugin marketplace add vredchenko/claude-transcripts` and
`/plugin install claude-transcripts@claude-transcripts`. The CLI must be installed too:
the plugin does no work itself. `claude-transcripts install` remains the main path and
registers the hook and statusline without the plugin
([installation.md](../start/installation.md#registering-the-hook-binary-or-plugin)).

It is one plugin rather than a writer and a reader, so one install gets both; a user
who only wants logging sets `recall_mode` to `off`. Two platform constraints shape it:
installing copies the plugin directory to a cache, so nothing in it may reference
`../`; and a plugin's `settings.json` may set only `agent` and `subagentStatusLine`,
not `statusLine`.

## Part 1 — visibility

A silent hook and a broken hook look the same from inside Claude Code. Three channels
answer "is it recording?" at different moments.

### 1a. Session-start banner

The `announce-recording` action, on `SessionStart`, prints hook JSON whose
`systemMessage` names where the session is recorded:

```
Claude Transcripts — recording to couchdb://…/claude-transcripts-sessions + s3://claude-transcripts-sessions · http://127.0.0.1:7650/app/sessions/<session_id>
```

It runs ahead of the config check, so an unconfigured machine says so:
`Claude Transcripts — not recording (no instance configured). Run claude-transcripts install.`
Every URL comes from the resolved config. It is the only hook output on stdout, which
is why `SessionStart` is registered synchronously ([hook.md](../reference/hook.md#dispatch)).

### 1b. Statusline

```
● ct@v0.2.0 rec · 128 ev · 6 tools · 2s ago → sessions@127.0.0.1:7652
◐ ct stalled …
○ ct@dev off · no instance configured
```

`claude-transcripts statusline render` reads the hook's per-session scratch files in
`/tmp` (counters, and a `.targets` file with the resolved stores, webapi and time of the
last successful write, credentials stripped) and makes no network calls. The last-write
time is what separates recording from configured-but-failing. The version shown is the
recording binary's (`ct@dev` from a checkout), since that is the half of a version skew
you otherwise can't see.

The plugin's `bin/claude-transcripts-statusline` just finds the installed CLI and runs
`statusline render`, falling back to `○ ct off`, so the state format has one
implementation. Because a plugin can't set `statusLine`, the CLI registers it:
`claude-transcripts statusline install` (run by `install` unless `--no-statusline`)
merges it into `~/.claude/settings.json` and leaves an existing `statusLine` alone,
printing how to combine the two. The plugin's `settings.json` sets
`subagentStatusLine`.

### 1c. `/claude-transcripts:status`

The on-demand answer: instance URL and version, hook registration and events, CouchDB
and S3 reachability, Meilisearch state, this session's id and webui link, and the
running counts.

## Part 2 — skills

Skills load only when their description matches, so they cost nothing until used. They
call the CLI with `--json`.

- **`recall`** — "have we done this before?". Triggers on did-we / why-is-this /
  what-did-we-decide questions, familiar errors, and before re-deriving prior work.
  Runs `claude-transcripts search "<query>" --json`, opens at most one or two sessions,
  and answers citing session id, date and cwd. Snippets only, never a whole transcript;
  results capped by `maxResults` and `maxSnippetChars`; says when nothing was found;
  respects the configured scope.
- **`session-history`** — patterns across your own history (repeated requests, failing
  tools, token use per project), via `claude-transcripts turns` and the `/api/couch`
  views.
- **`transcripts-admin`** — `doctor`, `backfill`, `reindex`, `export`/`import`,
  `migrate`, `stack`, and what to do for each statusline state.

An MCP server would be more native, but every tool definition is charged on every turn
and it needs a running process. It remains an option once recall proves it is worth
permanent context.

## Part 3 — recall policy

A skill description decides whether Claude loads a skill, not whether it thinks to
look. So the `inject-recall-policy` action adds a short `additionalContext` at session
start, combining the policy with a fact that makes it actionable
([ADR 0029](decisions/0029-recall-policy-config-driven-session-start.md)):

```
Session history for this project is available via `claude-transcripts search`.
This directory has 37 recorded sessions, most recent 2 days ago.
Before answering a question about why existing code is the way it is, or before
re-deriving something that looks like prior work here, search history first.
Cite the session id and date. Scope: this project. Max 5 results, snippets only.
```

The count comes from one `GET /api/sessions` with a 2 s timeout. The primer is capped
(`primer.maxTokens`, 200) and omitted when `mode` is `off`, the directory matches
`excludeCwdGlobs`, it has no history, or the webapi doesn't answer in time.

The policy is the `recall` section of the app config
([configuration.md](../start/configuration.md#settings)), resolved through the app
model and baked into the hook config. The plugin's `userConfig` options
`recall_mode`, `recall_scope` and `max_results` override it per user. Precedence:
`userConfig`, then the deployment config, then built-in defaults.

Injecting per prompt on `UserPromptSubmit` was rejected: it puts a process start and a
prompt classifier on the hot path of a component that must not fail.

## Invariants

1. Never block a session: every surface exits 0 and stays quiet on failure.
2. Never claim to be recording when it isn't: the indicator comes from the writer's own
   config and a real recent write.
3. The statusline makes no network calls.
4. No environment specifics: every host, port, database and bucket comes from config.
5. Recall never puts a whole transcript into context.
6. One implementation of the state format, in the CLI.

## Privacy

Recall reads past sessions into the current one. `scope: "project"` and
`excludeCwdGlobs` limit what can come back, and wider scopes are opt-in. With
`features.secretsMasking` still unimplemented, masking is a prerequisite for scopes
wider than `project`.

Not done: the optional MCP server, a vector index for better retrieval, and renaming
`hooks/` to `plugin/`.

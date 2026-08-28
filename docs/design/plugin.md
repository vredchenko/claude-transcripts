# The Claude Code plugin — visibility, recall, policy

> **Status: P0 + P1 built (visibility); P2 (recall) and P3 not yet.** `search --json`,
> `sessions --json`, the `announce-recording` banner, the statusline (`claude-transcripts
> statusline`), `/claude-transcripts:status`, `subagentStatusLine` and the marketplace
> file all exist — see [`hooks/README.md`](../../hooks/README.md). `hooks/` was **not**
> renamed (open question 1: deferred; nothing installs by path yet). This is the plan for growing
> [`hooks/`](../../hooks/) from a write-only shim into a full Claude Code plugin that
> (a) *shows* the user their session is being recorded and where, (b) gives Claude
> **skills** for reading the corpus back, and (c) carries **config** that tells Claude
> when to reach for history on its own. It closes two roadmap items — the
> [statusline indicator](roadmap.md) and the [recall plugin (#10)](roadmap.md) — and is
> the first Tier-2 feature that makes the archive an *input* rather than a record
> ([tiers.md](tiers.md#tier-2--make-history-actively-useful)).

## The problem, in three parts

Today the plugin is honest and invisible. `scripts/dispatch.ts` pipes a hook payload to
`claude-transcripts hook run` and exits 0 whatever happens ([hook.md](../reference/hook.md)).
That is exactly right for a writer — **the hook never blocks a session** — but it means:

1. **You cannot tell whether it is working.** A silent hook and a broken hook look
   identical from inside Claude Code. The only way to find out you lost a week of
   history is to go looking for it.
2. **Claude cannot read what it wrote.** The corpus is queryable — `/api/search`,
   `/api/turns`, the speaker-split views ([routes.md](../reference/routes.md)) — but nothing
   tells a live session that any of it exists.
3. **Even when Claude knows, it waits to be asked.** "Search my history" is a thing
   users have to think of. The value is in the sessions where they *don't* think of it.

Each part needs a different mechanism, and the third is the one that is easy to get
wrong.

## Shape: one plugin, grown in place

`hooks/` becomes the plugin root and gains skills, a slash command, a statusline
renderer and user config. The repo gains a `.claude-plugin/marketplace.json` so it is
its own marketplace.

```
.claude-plugin/marketplace.json        NEW  the repo is the marketplace
hooks/                                      the plugin root (rename → plugin/, see below)
├── .claude-plugin/plugin.json              grows: skills, commands, userConfig, bin
├── hooks/hooks.json                        generated from BINDINGS — mechanism unchanged
├── scripts/dispatch.ts                     the shim — unchanged
├── settings.json                     NEW  subagentStatusLine (the one key we may set)
├── bin/
│   └── claude-transcripts-statusline NEW  statusline renderer (plugin bin/ lands on PATH)
├── commands/
│   └── status.md                     NEW  /claude-transcripts:status
└── skills/
    ├── recall/SKILL.md               NEW  "have we done this before?"
    ├── session-history/SKILL.md      NEW  patterns across the corpus
    └── transcripts-admin/SKILL.md    NEW  operate + troubleshoot the store
```

**Why one plugin and not two.** Splitting writer and reader looks tidy — Tier 1 vs
Tier 2 — but it costs the user two installs to get one feature, and the reader would
have to rediscover the instance the writer already resolved. The recall half is gated
by `userConfig` instead, so a user who only wants logging turns it off and pays
nothing for it.

**Installation.** With the marketplace file in the repo root:

```
/plugin marketplace add vredchenko/claude-transcripts
/plugin install claude-transcripts@claude-transcripts
```

`claude-transcripts install` stays the primary path ([installation.md](installation.md)) —
it needs neither Bun nor a checkout. The plugin is for people who prefer Claude Code's
own mechanism, and it still requires the CLI, because the CLI does the work.

**Two platform constraints to design around**, both verified against the plugin
reference:

- Installing **copies the plugin directory to a cache**, so nothing in it may reference
  `../`. The shim already only uses `CLAUDE_PLUGIN_ROOT` and the installed binary; the
  statusline renderer must be equally self-contained.
- A plugin's `settings.json` accepts **only `agent` and `subagentStatusLine`**.
  `statusLine` is *not* a key a plugin can set. The main statusline therefore has to be
  registered into the user's `~/.claude/settings.json` — see below.

**Rename `hooks/` → `plugin/`?** `hooks/hooks/hooks.json` is already confusing, and the
directory is about to hold three skills and a command. The move is mechanical (one path
in `scripts/sync-hooks.ts`, the marketplace `source`, some doc links) and safe, because
no one installs by path today. Recommended, but separable from everything else here.

---

## Part 1 — visibility: "recording, and here's where"

Three channels, because a user needs the answer at three different moments: when the
session opens, continuously while they work, and on demand when they suspect something
is wrong.

### 1a. The session-start banner

A new action, **`announce-recording`**, bound to `SessionStart`. Dispatch already runs
actions from the model's `BINDINGS` ([ADR 0017](decisions/0017-hooks-and-actions-decoupled.md)), and
`SessionStart` is one of the two long-timeout events, so there is room. It writes hook
JSON on stdout:

```json
{
  "systemMessage": "Claude Transcripts — recording to couchdb://…/claude-transcripts-sessions + s3://claude-transcripts-sessions · http://127.0.0.1:7650/app/sessions/<session_id>",
  "hookSpecificOutput": {
    "hookEventName": "SessionStart",
    "additionalContext": "…"
  }
}
```

`systemMessage` renders in the transcript for the user; `additionalContext` is Part 3's
payload and is discussed there. Three details matter:

- **stdout is currently unused and must stay that way elsewhere.** Only `SessionStart`,
  `UserPromptSubmit` and `UserPromptExpansion` treat hook stdout as context; on every
  other event it goes to the debug log. `announce-recording` is bound to `SessionStart`
  alone, and nothing else in the hook may start printing to stdout. The plugin shim
  inherits the child's stdout, so this passes through both install paths unchanged.
- **The negative case is the important one.** Today `loadHookConfig` returning `null`
  means "not installed → silently do nothing". Silence is precisely the failure this
  whole part exists to fix, so the announcement has to run *before* the config gate and
  say so:
  `Claude Transcripts — not recording (no instance configured). Run `claude-transcripts install`.`
  This is the one deliberate exception to the config gate, and it still must never
  block: a failure to announce is swallowed like any other.
- **No environment specifics.** Every URL in the banner comes from the resolved
  instance config, never a literal.

### 1b. The statusline

A persistent one-liner is what actually answers "is it still working" while you work:

```
● ct rec · 128 ev · 6 tools · 2s ago → sessions@127.0.0.1:7652
○ ct off · no instance configured
```

The renderer ships as `bin/claude-transcripts-statusline` (a plugin's `bin/` is added to
PATH). It receives the statusline JSON on stdin — `session_id`, `cwd`, `model`,
`context_window`, and the rest — and must be **cheap**, because it runs on a tight
refresh. So it does **no network I/O at all**. Two candidate implementations:

| | How | Cost | Drift risk |
|---|---|---|---|
| **A. Read the scratch files** | Parse `/tmp/claude-transcripts-<id>.counts` directly | Free | Two spellings of the path and format, one of them in a directory that gets copied to a cache |
| **B. Spawn the CLI** (recommended) | `claude-transcripts statusline render` and print what it says | One short-lived binary start per refresh | None — one implementation, the same resolution `dispatch.ts` already does |

Recommend **B**, falling back to a bare `○ ct off` when the binary isn't resolvable —
same posture as the shim. It keeps the **one writer, one implementation** rule
([CLAUDE.md](../../CLAUDE.md#key-invariants)) instead of reintroducing the
"keep these two files identical" problem the plugin was just freed from.

Either way the data is local. The hook already maintains per-session state across its
many short-lived processes (`makeCounts`, `makeChunkState` in
`packages/cli/src/hook/runtime.ts`) — that is the live counter. It is missing the
*where*, so `seed-session-start` gains a sibling scratch file holding the resolved
targets (Couch URL + database, bucket, webapi URL, active features) and the timestamp
of the last successful write. That last field is what lets the indicator distinguish
**recording** from **configured but failing** — a store that has been refusing writes
for five minutes should not show a confident green dot.

**Registration.** Because a plugin may not set `statusLine`, this needs a new CLI
command — `claude-transcripts statusline install|uninstall|status` — merging into
`~/.claude/settings.json` exactly the way `hook install` already does, and with the same
care: never touch a key that isn't ours. `statusLine` is a *single* setting, so if the
user already has one, we do not overwrite it — print the snippet, explain how to
compose it, and exit. `install` offers to wire it; `--no-statusline` opts out.

`subagentStatusLine` **can** ship in the plugin's `settings.json`, so subagent rows get
the same indicator for free.

### 1c. `/claude-transcripts:status`

The on-demand, full answer — a `commands/status.md` slash command that renders what
`hook status`, `doctor` and the live counters already know: instance URL and version,
hook registration state and which events, Couch databases and reachability, S3 bucket,
Meilisearch state, this session's document id and a deep link into the webui, and the
running event/token counts. When something is wrong, this is the page that says what.

---

## Part 2 — skills: how Claude uses the history

Skills are the right carrier: they are lazy-loaded, so they cost nothing until their
description matches, and the CLI is already meant to be the surface
"[AI agents drive] headless" ([cli.md](../reference/cli.md)).

### `recall` — "have we done this before?"

The core skill. Triggers on *did we / have we / why is this like this / what did we
decide* questions, on an error that smells familiar, and before re-deriving something
that looks like prior work.

Procedure: `claude-transcripts search "<query>" --json` → session hits (metadata) and
turn hits (content, cropped snippets) → `claude-transcripts sessions <id> --json` only
for the one or two that matter → answer **citing session id, date and cwd** so the user
can open the source. Hard rules in the skill body:

- Snippets and ids, **never a whole transcript**. A recalled session must not eat the
  context window it is supposed to save.
- Cap results (`maxResults`, default 5) and snippet length.
- Say when recall found nothing, rather than reasoning from an empty result.
- Respect the configured scope (Part 3) — by default, sessions from this project only.

### `session-history` — patterns across the corpus

Questions about your own working history rather than one past answer: what do I keep
asking for, which tools fail most, where did this file get touched, token and cost
rollups per project. Built on `/api/turns` (cross-session, speaker-split, time-ordered)
and the `/api/couch` view proxy — the surfaces that already exist for exactly this
([ADR 0027](decisions/0027-full-content-chunks-in-couchdb.md)).

### `transcripts-admin` — operate and troubleshoot

Makes the plugin self-supporting: `doctor`, `backfill`, `reindex`, `export`/`import`,
`migrate`, `stack`, plus a decision tree from each indicator state ("statusline says
*off*" → "*configured but failing*" → …) to the command that fixes it. This is where the
"where is my data" question gets its long answer.

### Skills or an MCP server?

An MCP server exposing `search_sessions` / `get_session` / `list_turns` would be more
native. It is also **always in context** — every tool definition is charged on every
turn of every session, whether or not history is ever consulted — and it needs a live
process. Skills cost nothing until triggered and reuse the CLI we already ship. So:
**skills now**; revisit an optional `mcpServers` entry once the recall loop has proven
it earns permanent context space.

### Prerequisite, and it is a real one

`claude-transcripts search` runs since 0.0.12 (it had been in the model's `CLI_SPEC`
without a `COMMANDS` entry, and fell through to the help UI; a test now keeps the two
lists equal in both directions — `packages/cli/src/commands/index.test.ts`). What is
still missing is a machine-readable form: there is no `--json` on `search` or
`sessions`, and both skills above assume one. That is a genuine blocker, not a detail,
and is sequenced as P0 below.

---

## Part 3 — config: when to reach for history unprompted

This is the part that is easy to hand-wave. A skill's `description` only decides whether
Claude *loads* the skill; it does not make Claude think of looking. For history to be
consulted without being asked, two things have to be true at turn zero: Claude must know
**the rules**, and it must know **that there is something here to find**.

### The policy lives in `config/`

Deployment-wide, non-secret config belongs in `config/`, and config is expected to grow
to several files there ([CLAUDE.md](../../CLAUDE.md#key-invariants)). So: `config/recall.json`,
template-committed with conservative defaults, projected through the app model like
everything else — consumers read `model.recall`, they do not re-derive it.

```jsonc
{
  "recall": {
    "mode": "auto",             // off | suggest | auto
    "scope": "project",         // project | host | all
    "maxResults": 5,
    "maxSnippetChars": 400,
    "triggers": {
      "priorWorkQuestion": true,   // "did we…", "why is this…", "what did we decide…"
      "repeatedError": true,       // an error that appears in past sessions
      "beforeRederiving": true     // about to redo something that looks like prior work
    },
    "excludeCwdGlobs": [],      // paths never recalled from
    "primer": { "onSessionStart": true, "maxTokens": 200 }
  }
}
```

### Per-user override via `userConfig`

The plugin manifest's `userConfig` is prompted at enable time and needs no file editing,
which makes it the right place for the per-user, per-machine slice: `recall_mode`,
`recall_scope`, `webapi_url`, `max_results`. Values arrive as `${user_config.KEY}`
substitutions in hook commands and as `CLAUDE_PLUGIN_OPTION_*` environment variables.

**Precedence, stated once:** `userConfig` (this user, this machine) → `config/recall.json`
(this deployment) → built-in defaults.

### How it reaches Claude: the session-start primer

A second `SessionStart` action, **`inject-recall-policy`**, emits
`hookSpecificOutput.additionalContext` — a short block combining the rules with the
local facts that make them worth acting on:

```
Session history for this project is available via `claude-transcripts search`.
This directory has 37 recorded sessions, most recent 2 days ago.
Before answering a question about why existing code is the way it is, or before
re-deriving something that looks like prior work here, search history first.
Cite the session id and date. Scope: this project. Max 5 results, snippets only.
```

The count is what converts a generic instruction into a triggered one — Claude knows
there *is* history here, not merely that history is a concept. It costs one cheap
cwd-scoped query at session start.

**Budget discipline.** This is charged on every session, so it is capped (~200 tokens),
and it is **omitted entirely** when `mode: "off"`, when the store is unreachable, or
when this cwd has no prior sessions. An empty corpus must not pay for a primer telling
Claude to search it.

### Rejected: nudging on `UserPromptSubmit`

Injecting per-prompt, only when the prompt matches a trigger, is the obvious
"smarter" design. It is also on the hot path — a 5-second timeout and a process start on
every single prompt — and it puts a fragile prompt classifier in a component that is not
allowed to fail. The session-start primer plus the skill descriptions get most of the
benefit at none of that cost. Revisit only with evidence that the primer is being
ignored.

---

## Invariants this plugin must not break

1. **Never block a session.** Every new surface — announce, primer, statusline,
   registration — exits 0, prints nothing on failure, and is wrapped. This overrides
   everything else on this page.
2. **Never claim to be recording when it isn't.** The indicator is derived from the same
   config the writer reads and from a real recent write, not from "the plugin is
   installed". A confident green dot over a dead store is worse than no dot.
3. **The statusline does no network I/O**, ever.
4. **No environment specifics** in the plugin. Every host, port, database and bucket is
   resolved from config; only the documented `127.0.0.1` dev defaults ship.
5. **Recall never dumps a transcript into context** — ids and snippets, capped.
6. **One implementation.** The statusline renders through the CLI rather than growing a
   second copy of the state format ([CLAUDE.md](../../CLAUDE.md#key-invariants)).

### Privacy, and a flag on `secretsMasking`

Recall reads prior sessions back into a live one. Default `scope: "project"` and
`excludeCwdGlobs` are the guardrails, and cross-project recall stays opt-in. Worth
stating plainly: `features.secretsMasking` is currently `false`, and content flowing
*back into* a session is exactly the case that makes masking matter. Turning recall on
raises that flag's priority from nice-to-have to prerequisite for `scope` values wider
than `project`.

---

## Sequencing

| Phase | Work | Closes |
|---|---|---|
| **P0 — prerequisites** ✅ | `--json` on `search` and `sessions`; extend the per-session scratch state with resolved targets + last-write time (`/tmp/claude-transcripts-<id>.targets`, credentials stripped) | — |
| **P1 — visibility** ✅ | `.claude-plugin/marketplace.json`; plugin manifest grows; `announce-recording` action; `/claude-transcripts:status`; statusline renderer + `statusline install`; `subagentStatusLine` | roadmap *statusline indicator* |
| **P2 — recall** | `recall` skill; `config/recall.json` + model projection; `inject-recall-policy`; `userConfig` | roadmap #10, Tier 2 recall |
| **P3 — depth** | `session-history` + `transcripts-admin` skills; optional MCP server; vector index for retrieval quality | #9 |

P1 is independently shippable and useful on its own — it is the half that stops the
system being invisible. P2 is the half that makes it valuable.

## Decisions to record

- **ADR — the repo is its own plugin marketplace, one plugin grown in place.** Why not
  two plugins, and what the copy-to-cache constraint means for the layout.
- **ADR — recall policy is config-driven and injected at session start.** Why not the
  per-prompt hot path, and how `userConfig` and `config/` compose.
- **ADR — the statusline is registered by the CLI, not the plugin.** Documents the
  platform constraint so the next person does not rediscover it, and the rule about
  never overwriting an existing `statusLine`.

## Open questions

1. Rename `hooks/` → `plugin/` as part of P1, or leave it?
2. Default `recall.mode` — `auto` (the point of the feature) or `suggest` (Claude
   proposes, the user confirms) for the first release?
3. Should `install` wire the statusline by default, or only on `--statusline`?
4. Does the primer's "37 sessions here" count justify a cwd-scoped query on every
   session start, or should it be cached in the scratch state and refreshed daily?

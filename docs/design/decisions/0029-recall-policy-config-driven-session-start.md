# 29. The recall policy is config-driven and injected at session start

Date: 2026-08-28

## Status

Accepted — built in the P2 pass of [plugin.md](../plugin.md).

## Context

Recording sessions is only half of the value; the other half is a live session
*using* what was recorded. A skill (`recall`) can teach Claude *how* to search the
corpus, but a skill's description only decides whether it gets loaded — it does not
make Claude think of looking. For history to be consulted without being asked, two
things must be true at turn zero: Claude must know **the rules** (when to search, how
widely, how much to read back), and it must know **that there is something here to
find**.

Where should the rules live, and how should they reach a session?

## Options

1. **Nudge on every prompt** — a `UserPromptSubmit` hook classifies the prompt and
   injects "search history" only when it matches a trigger. Smartest, and on the hot
   path: a 5-second timeout and a process start on every prompt, plus a fragile
   classifier inside a component that is not allowed to fail.
2. **Hard-code the policy in the skill** — no config, the SKILL.md says "always search
   first". Zero cost, but one user's preference becomes everyone's, and there is no
   per-deployment or per-machine way to turn it down.
3. **Config + one session-start primer** — the policy is a `recall` section of the
   deployment config, projected through the app model like everything else;
   a `SessionStart` action resolves it, asks the webapi how much history this cwd
   has, and injects a short `additionalContext` block combining the two. Per-user
   overrides come from the plugin's `userConfig`.

## Decision

Option 3.

- **The policy lives in config, resolved by the model.** `config.recall` (mode, scope,
  limits, triggers, exclusions, primer budget) is defaulted and resolved by
  `resolveRecall` in `@claude-transcripts/shared`; the model carries `model.recall`
  and the manifest exposes it. Consumers read the resolved policy — the hook, the
  webui — and never re-derive it. It is baked into the hook's runtime config at
  install time so the hook needs no checkout.
- **Precedence, stated once:** plugin `userConfig` (this user, this machine; arrives
  as `CLAUDE_PLUGIN_OPTION_RECALL_MODE` / `_RECALL_SCOPE` / `_MAX_RESULTS`) →
  `config.recall` (this deployment) → built-in defaults.
- **Injected once, at session start**, by the `inject-recall-policy` action, into the
  same single JSON object `announce-recording` writes (Claude Code parses hook stdout
  as one object). The primer states the scope, the command to run, the count of
  recorded sessions in scope and their recency, the triggers, and the citation rule.
- **Omitted entirely** when `mode` is `off`, the primer is disabled, the cwd matches
  `excludeCwdGlobs`, the webapi does not answer within 2 s, or the corpus for this
  scope is **empty**. An empty corpus must not pay for a primer telling Claude to
  search it. Budget ≈ 200 tokens.
- **Default scope is `project`.** Cross-project recall reads other work's content back
  into a session, which is what makes `features.secretsMasking` matter — and it is
  still off. Widening scope is a deliberate, per-deployment or per-user choice.

The policy is a **section of the single config file** rather than the separate
`config/recall.json` the design sketched: the loaders (`loadAppConfig`, the embedded
template, `app.json` seeding) are single-file today, and splitting them is a change
of its own. The schema is the same; the file can be split when a multi-file config
loader lands.

## Consequences

- The primer costs one cheap cwd-scoped `GET /api/sessions?cwd=…&limit=1` per session
  start (the route gained `cwd` and `hostname` filters). If that proves noticeable,
  the count can be cached in the per-session scratch state and refreshed daily
  (plugin.md, open question 4).
- Rejected for now: per-prompt nudging (option 1). Revisit only with evidence that the
  session-start primer is being ignored.
- An optional MCP server (`search_sessions` / `get_session`) remains a later option; it
  would be always-in-context, so it has to earn that space first.

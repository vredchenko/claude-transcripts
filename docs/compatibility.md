# Claude Code compatibility

> **Status: structure defined, data auto-generated (not yet wired).** This doc
> defines *how* we track which Claude Code versions we support and which hooks each
> exposes. The data is **machine-generated from an external source of truth**, not
> hand-maintained.

We pin our relationship to Claude Code with a small **structured, formal
definition** — a committed data file (working name `compatibility.json`) — that
records three versions of interest and the hook set each supports:

| Field | Meaning | Source |
|-------|---------|--------|
| `latestPublic` | The latest publicly released Claude Code CLI version | **auto-generated** from the external source of truth (CC releases/docs) |
| `earliestCompatible` | Oldest CC version our system is verified to work with | **test automation** (not built yet — see below) |
| `latestCompatible` | Newest CC version our system is verified to work with | **test automation** (not built yet) |

For **each** of those three versions we record the **complete list of supported
hook events** (so we can reason about coverage and drift per version).

## Shape (placeholder)

```jsonc
{
  "generatedAt": "<iso8601>",
  "source": "<url of the external source of truth>",
  "claudeCode": {
    "latestPublic":       { "version": "x.y.z", "hooks": ["SessionStart", "…"] },
    "latestCompatible":   { "version": "d.e.f", "hooks": ["…"] },
    "earliestCompatible": { "version": "a.b.c", "hooks": ["…"] }
  }
}
```

(Version strings are placeholders — they are filled by automation, never by hand.)

## How it's produced

- **`latestPublic` + per-version hook lists** — a dev script
  ([dev-automation.md](dev-automation.md)) scrapes/queries the **external source of
  truth** for Claude Code (its published hooks docs / release metadata) and
  regenerates `compatibility.json`. Run locally via `bun run` and wrapped as a
  CI/CD job; the same automation backs the **hook-drift check** (Tier 3,
  [hooks.md](hooks.md), #13) — it diffs our codebase's hook list against the
  generated set.
- **`earliestCompatible` / `latestCompatible`** — determined by a **test
  automation** suite we don't have yet: it runs the [e2e suite](testing.md)
  against multiple Claude Code versions and records the verified compatibility
  window. Until that exists these fields are placeholders.

## Relationship to the hooks table

[hooks.md](hooks.md) is the **codebase-side** master table of hook types (with the
owner's "what we do on each hook" column). `compatibility.json` is the
**external-truth** per-version view. The drift check compares the two; a mismatch
means Claude Code added/removed a hook we haven't accounted for.

> Tier 1 ships the *structure* + the generator for `latestPublic`; the
> compatibility-window automation is a later milestone gated on the e2e suite.

# Claude Code compatibility

**Not built yet.** There is no verified range of supported Claude Code versions. The
hook targets the hook events listed in [hook-events.md](../reference/hook-events.md).

The plan ([ADR 0025](../design/decisions/0025-claude-code-compatibility-matrix.md)) is
a generated `compatibility.json` recording three Claude Code versions and the hook
events each supports:

| Field | Meaning | Source |
|-------|---------|--------|
| `latestPublic` | Latest released Claude Code | scraped from Claude Code's published docs/releases |
| `earliestCompatible` | Oldest version verified to work | an e2e run against several Claude Code versions |
| `latestCompatible` | Newest version verified to work | the same |

```jsonc
{
  "generatedAt": "<iso8601>",
  "source": "<url>",
  "claudeCode": {
    "latestPublic":       { "version": "x.y.z", "hooks": ["SessionStart", "…"] },
    "latestCompatible":   { "version": "x.y.z", "hooks": ["…"] },
    "earliestCompatible": { "version": "x.y.z", "hooks": ["…"] }
  }
}
```

A drift check would then diff the generated hook list against the blueprint's
`HOOK_TYPES`. Today `bun run gen:compat` (part of `gen:all`) writes a placeholder
(version `0.0.0`, no hooks), and `compatibility.json` is gitignored until it produces
real data.

# Mock Claude Code hook payloads

Example **stdin payloads** Claude Code sends to a hook, one folder per event. They
serve two purposes: documenting each event's input shape (referenced from
[`docs/hook-events.md`](../../../../docs/hook-events.md)) and feeding **test
automation** (dispatch/handler unit tests, the smoke test, fixture-driven
round-trips).

> **Status: placeholders.** Most files here are **synthetic but shape-faithful** —
> correct field names/types with obviously-fake values — created before we had real
> captures. We replace/augment them with **real payloads harvested from actual
> sessions** as we go. A hook just receives JSON on stdin, so capturing is easy:
> point the hook command at `tee` (or add a debug action) and save the JSON.

## Layout

```
tests/mock/claude-code/hooks/
  <event-kebab-name>/        # one dir per hook event (e.g. session-start/)
    <scenario>.json          # one or more example payloads
  _edge-cases/               # cross-event robustness payloads
```

Folder names are the event name in kebab-case (`PostToolUseFailure` →
`post-tool-use-failure/`). `docs/hook-events.md` links to the **folder**, so adding
or renaming individual scenario files never breaks the docs.

## Placeholder value convention

So fixtures are recognisable as synthetic and stay consistent:

| Field | Placeholder value |
|-------|-------------------|
| `session_id` | `00000000-0000-4000-8000-000000000000` |
| `transcript_path` | `/home/USER/.claude/projects/PROJECT/00000000-0000-4000-8000-000000000000.jsonl` |
| `cwd` | `/home/USER/project` |
| `model` | `claude-opus-4-8` |
| timestamps | `2026-01-01T00:00:00.000Z` |

Every payload is a **valid JSON object** and includes `hook_event_name` matching
its event. Real captured payloads keep their real values — only the synthetic
placeholders use the table above.

## Scenario / variety dimensions

Where an event has meaningful variation, we keep **several** files. Common axes:

- **source/trigger/reason variants** — e.g. `session-start/{startup,resume,clear,compact}.json`,
  `pre-compact/{manual,auto}.json`, `session-end/{prompt-input-exit,logout,clear,other-abnormal}.json`.
- **success vs failure** — `post-tool-use/*` vs `post-tool-use-failure/*`,
  `stop/*` vs `stop-failure/*`.
- **tool variety** — `pre-tool-use/{bash,edit,mcp,dangerous-bash}.json`.
- **size extremes** — `*/oversized-*.json` (very long content, to test chunking /
  truncation / token math) and the empty/minimal cases in `_edge-cases/`.

## `_edge-cases/`

Robustness payloads not tied to one event — empty objects, missing common fields,
wrong types, oversized content, unknown/future event names. The dispatcher must
**never crash a session** ([CLAUDE.md key invariants]), so these assert graceful
skips.

## Provenance: synthetic vs. real

- **`real-*.json`** — derived from an **actual session transcript** (real
  `tool_input`/`tool_output` bodies for `PreToolUse`/`PostToolUse`), then
  **sanitised** for public release: usernames, hostnames, emails, IPs, internal
  domains, and any credential-shaped strings are stripped/placeholdered. Only
  benign tool calls (reading/editing/writing source & docs, harmless shell) were
  selected; secret-bearing calls were excluded by hand and a final scan gates the
  set. The `session_id`/`transcript_path` envelope is placeholdered; `cwd`/paths
  keep a realistic (sanitised) shape.
- **All other files** — synthetic, shape-faithful placeholders.

> Sanitisation map applied to `real-*`: real home/username → `/home/USER`,
> hostname → `HOST`, real session id → the placeholder UUID, internal git-host domain
> → `git.example.com`, real email → `user@example.com`, IPs → `0.0.0.0`.
> When adding more real captures, re-run the same scrub + secret scan before
> committing. **Never** capture from a session whose transcript printed secrets.

## Using fixtures in tests

Load a file, feed it to `dispatch.ts` (or a handler) as stdin, and assert on the
CouchDB/S3 effects. Keep assertions tolerant of placeholder values; assert on
**shape and behaviour**, not on the synthetic ids.

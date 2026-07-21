#!/usr/bin/env bun
import { join } from "node:path";
import type { HookCategory } from "@claude-transcripts/shared";
/**
 * Generate docs/hook-events.md from the app model — the hook-events table is a
 * PROJECTION of HOOK_TYPES (toHookEventRows): rows, docs links, fixture-folder
 * links, and the "What we do" column (projected from BINDINGS) all come from the
 * model. Edit the model (hooks.ts / actions.ts), not this doc.
 *
 *   bun run scripts/gen-hook-events.ts   (or: bun run gen:hook-events)
 */
import { buildAppModel, type HookEventRow, toHookEventRows } from "@claude-transcripts/shared";
import { loadConfigFile } from "./lib/config-file";

const ROOT = join(import.meta.dir, "..");
const rows = toHookEventRows(buildAppModel(loadConfigFile(ROOT), process.env));

const SECTION_TITLES: Record<HookCategory, string> = {
  "session-start": "Session start & setup",
  "turn-input": "Turn input",
  tool: "Tool lifecycle",
  subagent: "Subagents, teams & tasks",
  display: "Display, MCP & notifications",
  environment: "Environment, config & files",
  worktree: "Worktrees",
  compaction: "Compaction",
  "turn-end": "Turn end",
  "session-end": "Session end",
};

const FIXTURES = "../tests/mock/claude-code/hooks";

function renderRow(r: HookEventRow): string {
  // Wired → the bound action handlers; unwired → *why* we ignore it.
  const whatWeDo = r.wired
    ? r.actions.map((a) => `\`${a}\``).join(" · ")
    : r.ignoreReason
      ? `_ignored — ${r.ignoreReason}_`
      : "";
  return `| \`${r.event}\` | ${r.firesWhen} | [ref](${r.docsUrl}) | [${r.fixtureDir}/](${FIXTURES}/${r.fixtureDir}/) | ${whatWeDo} |`;
}

function renderSections(): string {
  const out: string[] = [];
  let cat: HookCategory | null = null;
  for (const r of rows) {
    if (r.category !== cat) {
      cat = r.category;
      out.push(
        `\n## ${SECTION_TITLES[cat]}\n`,
        "| Hook | Fires when | Docs | Examples | What we do |",
        "|------|------------|------|----------|------------|",
      );
    }
    out.push(renderRow(r));
  }
  return out.join("\n");
}

const wired = rows.filter((r) => r.wired);
const wiredList = wired.map((r) => `\`${r.event}\``).join(", ");

const doc = `<!-- GENERATED from the app model (@claude-transcripts/shared) by scripts/gen-hook-events.ts.
     Do NOT edit by hand — run \`bun run gen:hook-events\`. Edit the model:
     packages/shared/src/model/hooks.ts (events/order/summaries) and actions.ts
     (the "What we do" bindings). -->

# Claude Code hook events — when they fire, payloads & fixtures

The authoritative catalogue of **every Claude Code hook event**, projected from the
app model ([\`@claude-transcripts/shared\` HOOK_TYPES](../packages/shared/src/model/hooks.ts)):
the one-line trigger for each, a link to the official documentation, links to
example **payload fixtures** under
[\`tests/mock/claude-code/hooks/\`](${FIXTURES}/) (the inputs Claude Code sends a hook
on stdin — used for both these docs and test automation), and the action(s) we run.

This table is the **payload/fixture reference**. The complementary [hooks.md](hooks.md)
narrates the hook → action model, and [hook.md](hook.md) covers the writer
mechanics. The per-**version** authoritative list (which events each supported
Claude Code version exposes) is **generated** into \`compatibility.json\`
([compatibility.md](compatibility.md), [ADR 0025](decisions/0025-claude-code-compatibility-matrix.md))
— treat that as the source of truth if this table and a given CC version disagree.

- **Official reference:** <https://code.claude.com/docs/en/hooks>
- **Guide:** <https://code.claude.com/docs/en/hooks-guide>

## How to read this table

- **Fires when** — one-line trigger + what the event is for.
- **Docs** — deep link into the official hooks reference for that event.
- **Examples** — folder of example payload fixtures for that event (one or
  several JSON files; see [the fixtures README](${FIXTURES}/README.md) for the
  naming/variety convention). Many are **placeholders today** — synthetic but
  shape-faithful — to be supplemented with real captures over time.
- **What we do** — for **wired** events, the action handlers bound to it (projected
  from the model's BINDINGS; [actions.md](actions.md) lists what each does). For
  **ignored** events, *why* we intentionally don't handle it. Both come from the
  model ([\`hooks.ts\`](../packages/shared/src/model/hooks.ts) +
  [\`actions.ts\`](../packages/shared/src/model/actions.ts)) — wire an ignored event
  by adding a binding and regenerating.

Events are ordered by **session lifecycle**: a session begins at the top and ends
(or crashes) at the bottom.

## Common payload fields

Every hook receives these on stdin; per-event fields are layered on top.

| Field | Type | Meaning |
|-------|------|---------|
| \`session_id\` | string | Claude Code's own session UUID — our stable key. |
| \`transcript_path\` | string | Absolute path to the session transcript (JSONL) on disk. |
| \`cwd\` | string | Working directory at the time the event fired. |
| \`hook_event_name\` | string | The event name (e.g. \`PostToolUse\`) — mirrors the row. |
| \`permission_mode\` | string? | Present on tool-related events (\`default\`, \`plan\`, …). |
| \`effort\` | object? | \`{ "level": "low\\|medium\\|high\\|…" }\` when applicable. |

---
${renderSections()}

> **On crashes.** There is **no dedicated "session crashed" event**. Abnormal
> termination surfaces in three ways, in increasing severity:
> 1. \`StopFailure\` — the turn hit an API/runtime error but the session is alive.
> 2. \`SessionEnd\` with \`reason: "other"\` — an orderly-but-non-standard shutdown.
> 3. **No \`SessionEnd\` at all** — a hard crash / kill. The session is then
>    detected as **\`incomplete\`** by derivation (see
>    [couchdb.md → status model](couchdb.md#status-model-derived-not-stored)) and
>    finalised by the \`reconcile\` utility ([tools.md](tools.md)). Fixtures for (1)
>    and (2) live under \`stop-failure/\` and \`session-end/\`; case (3) is exercised
>    by leaving a started session with no end fixture.

## Coverage vs. what we wire today

We currently bind actions to **${wired.length}** of the ${rows.length} events —
${wiredList}. The rest are **intentionally ignored** — the "What we do" column gives
the reason per event: a passive, observe-only writer gains nothing from
blocking / UX / orchestration hooks, and every hook invocation costs a Bun startup,
so we wire only the events that carry the session record ([hooks.md](hooks.md)).
Wiring an ignored event = add the [action](actions.md) + binding in the model and
register it in \`hooks.json\` (regenerated by \`bun run gen:hooks\`).

> **Field-shape caveat.** Payload field names/casing follow the official reference
> at authoring time. Claude Code is upstream and evolving; when in doubt, capture a
> real payload (every hook just receives JSON on stdin — \`… | tee fixture.json\`)
> and reconcile against \`compatibility.json\`.
`;

await Bun.write(join(ROOT, "docs", "hook-events.md"), doc);
console.log(
  `[gen-hook-events] wrote docs/hook-events.md (${rows.length} events, ${wired.length} wired)`,
);

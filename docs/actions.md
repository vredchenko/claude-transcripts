# Event-handling actions

An **action** is a single behaviour the system performs in response to a Claude
Code hook event. Actions are defined **independently of any specific hook**; the
[hook types](hooks.md) are bound to actions through a composable **many-to-many
mapping** ([ADR 0017](decisions/0017-hooks-and-actions-decoupled.md)). The same
action can be driven by several events; one event can drive several actions.

> Status: this catalogue formalises behaviours that today live inside the per-event
> handler modules. Treat entries without a ✅ as **placeholders** for planned
> actions.

## Action catalogue

| Action | What it does | Reads | Writes |
|--------|--------------|-------|--------|
| `write-event-marker` ✅ | Append a light `type:"event"` marker doc (event, `session_id`, `ts`, minimal payload) | hook payload | CouchDB |
| `update-counts` ✅ | Bump per-session counters (events/prompts/errors/tools) in `/tmp` | hook payload | `/tmp` |
| `flush-transcript-chunk` ✅ | Tail the live transcript and append `chunk:` docs (size/time batched) | `transcript_path` | CouchDB |
| `write-summary` ✅ | At session end, compute the rollup + token usage and write `summary:<id>` | transcript, counts | CouchDB |
| `upload-blobs` ✅ | Upload `summary.json` + `transcript.jsonl` to S3 | transcript, summary | S3 |
| `seed-session-start` ✅ | Reset counters + chunk offset; record start metadata | hook payload | `/tmp`, CouchDB |
| `enrich-metadata` | Post additional session metadata (actor/machine, harness config) to the schemaless meta endpoint | host/env | CouchDB (via webapi) |
| `extract-feature` | Map-reduce-friendly feature extraction (URLs, repos, PRs, `/`-commands, models) | chunks/markers | CouchDB views |
| `detect-memory-write` | Flag `Edit`/`Write` to `…/memory/`, `CLAUDE.md`, `AGENTS.md` as a memory save | tool input | CouchDB |
| `app-log` | Emit an operational log/error record for the component | runtime | app-log DB (see [app-logging.md](app-logging.md)) |
| `index-for-search` | Push derived content to the search backend (Meilisearch/vector) | chunks/markers | search index |
| `reconcile-session` | Finalize a stale `running` session from chunks/S3 | chunks, S3 | CouchDB |

(The last six are planned/placeholder; they line up with the Tier-2 and logging
roadmap items.)

## Current bindings (seed mapping)

The live `dispatch.ts` `REGISTRY` is the seed of the many-to-many table:

| Event | Bound actions (today) |
|-------|-----------------------|
| `SessionStart` | `seed-session-start`, `write-event-marker` |
| `UserPromptSubmit` | `write-event-marker`, `update-counts`, `flush-transcript-chunk` |
| `PostToolUse` | `write-event-marker`, `update-counts`, `flush-transcript-chunk` |
| `PostToolUseFailure` | `write-event-marker`, `update-counts`, `flush-transcript-chunk` |
| `Stop` | `write-event-marker`, `flush-transcript-chunk` (forced) |
| `SubagentStart` / `SubagentStop` | `write-event-marker`, `update-counts` |
| `SessionEnd` | `flush-transcript-chunk` (final), `write-summary`, `upload-blobs` |

> In the implemented hook these are still expressed as handler modules
> (`handlers/*` + the `chunk-flush` handler). The decoupled model reframes them as
> **actions bound to events**; the mapping becomes declarative and **configurable**
> per deployment (per the "everything configurable" goal —
> [configuration.md](configuration.md)).

## Design notes

- Actions are **observe-only** — they never block or modify a session, matching the
  hook's never-block invariant.
- Actions should be **independently failable**: one action throwing must not
  prevent the others bound to the same event (today: `Promise.allSettled` in
  `dispatch.ts`).
- New behaviour should be added as an **action** + a **binding**, not by hard-coding
  logic into a specific event handler — that's what keeps coverage and composition
  clean.

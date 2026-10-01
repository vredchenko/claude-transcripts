# Event-handling actions

An **action** is a single behaviour the system performs in response to a Claude
Code hook event. Actions are defined **independently of any specific hook**; the
[hook types](hooks.md) are bound to actions through a composable **many-to-many
mapping** ([ADR 0017](../design/decisions/0017-hooks-and-actions-decoupled.md)). The same
action can be driven by several events; one event can drive several actions.

> Status: entries with ✅ are implemented (`HANDLERS` in
> `packages/cli/src/hook/handlers.ts`); the rest are placeholders.

## Action catalogue

| Action | What it does | Reads | Writes |
|--------|--------------|-------|--------|
| `write-event-marker` ✅ | Append a light `type:"event"` marker doc (event, `session_id`, `ts`, minimal payload) | hook payload | CouchDB |
| `update-counts` ✅ | Bump per-session counters (events/prompts/errors/tools) in `/tmp` | hook payload | `/tmp` |
| `flush-transcript-chunk` ✅ | Tail the live transcript and append `chunk:` docs (size/time batched) | `transcript_path` | CouchDB |
| `write-summary` ✅ | At session end, compute the rollup + token usage and write `summary:<id>` (plus a `summary.json` copy in S3 when blobs are on) | transcript, counts | CouchDB, S3 |
| `upload-blobs` ✅ | Upload the byte-faithful `transcript.jsonl` to S3 | transcript | S3 |
| `seed-session-start` ✅ | Reset counters + chunk offset; write the resolved targets (stores, webapi, last-write time) for the statusline | hook payload, hook config | `/tmp`, CouchDB |
| `inject-recall-policy` ✅ | Prime the session with the recall policy and how much history this cwd has (`additionalContext`, same JSON object as the banner); omitted when off, excluded, empty or the webapi is slow ([ADR 0029](../design/decisions/0029-recall-policy-config-driven-session-start.md)) | hook config `recall`, webapi | stdout (context) |
| `announce-recording` ✅ | Print the session-start banner — recording to *where*, or **not recording** — as hook JSON on stdout (the hook's only stdout use; `SessionStart` only) | targets | stdout (transcript) |
| `enrich-metadata` | Post additional session metadata (actor/machine, harness config) to the schemaless meta endpoint | host/env | CouchDB (via webapi) |
| `extract-feature` | Map-reduce-friendly feature extraction (URLs, repos, PRs, `/`-commands, models) | chunks/markers | CouchDB views |
| `detect-memory-write` | Flag `Edit`/`Write` to `…/memory/`, `CLAUDE.md`, `AGENTS.md` as a memory save | tool input | CouchDB |
| `app-log` | Emit an operational log/error record for the component | runtime | app-log DB (see [app-logging.md](../operate/app-logging.md)) |
| `index-for-search` | Push derived content to the search backend (Meilisearch/vector) | chunks/markers | search index |
| `reconcile-session` | Finalize a stale `running` session from chunks/S3 | chunks, S3 | CouchDB |

(The last six are planned/placeholder; they line up with the Tier-2 and logging
roadmap items.)

## Current bindings (seed mapping)

`BINDINGS` (`packages/shared/src/model/actions.ts`) is the table; the hook looks
bindings up at dispatch and runs each key from `HANDLERS`, and `hooks.json` is generated
from it. The live event → actions list is projected into
[hook-events.md](hook-events.md) ("What we do").

> Already declarative (one `HANDLERS` entry per action, bound only via `BINDINGS`);
> still to do: per-deployment configuration ([configuration.md](../start/configuration.md)).

## Design notes

- Actions are **observe-only** — they never block or modify a session, matching the
  hook's never-block invariant.
- Actions should be **independently failable**: one action throwing must not
  prevent the others bound to the same event (today: `Promise.allSettled` in
  `packages/cli/src/hook/index.ts`).
- New behaviour should be added as an **action** + a **binding**, not by hard-coding
  logic into a specific event handler — that's what keeps coverage and composition
  clean.

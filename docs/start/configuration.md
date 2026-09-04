# Configuration

There are two layers of configuration, split by sensitivity:

| Layer | File | Holds | Committed? |
|-------|------|-------|-----------|
| **Top-level settings** | `config/config.template.json` → `config/config.json` | Non-secret, deployment-wide defaults: database/bucket names, feature flags, tunables, service-menu URLs | **Template yes**; the live `config/config.json` is `.gitignore`d |
| **Secrets & endpoints** | `.env` (per machine) | Hosts, ports, credentials, S3 keys | **No** (`.gitignore`d) |

Copy the template to `config/config.json` to customise an instance; the loader falls
back to the template, so zero-config development works out of the box. `.env` values
**override** the matching defaults. Anything secret or per-deployment belongs in
`.env`; anything stable and shareable belongs in `config/`, which is designed to grow
into **multiple files**.

## `config/config.json`

The committed template, in full — this is the current shape, not a target:

```jsonc
{
  "app": { "name": "claude-transcripts" },

  // CORE / system — dev-level settings & constants (not user-facing)
  "system": {
    "logging": { "chunk": { "maxEntriesPerChunk": 200, "flushIntervalMs": 15000 } },
    // session-lifecycle tunables. liveWindowMs: how long after its last activity a
    // still-open (no SessionEnd) session is treated as running/live before it reads
    // as incomplete/abandoned. Default 86_400_000 (24h). No live heartbeat exists,
    // so this is a recency heuristic; an abandoned session that gets new events
    // (within the window again) flips back to live automatically.
    // idleThresholdMs: gap between consecutive events above which the session counts
    // as idle when deriving *active* duration (vs total wall-clock runtime) on the
    // session detail. Default 300_000 (5 min) — a session left open in tmux stops
    // accruing active time past this gap.
    "sessions": { "liveWindowMs": 86400000, "idleThresholdMs": 300000 }
    // other tunables/constants live here
  },

  // NAMES — designed for MORE THAN ONE database, bucket and index from the start.
  // All three are namespaced so a deployment pointed at a store it doesn't
  // exclusively own can't collide with anything else there.
  "couchdb": {
    "databases": {
      "sessions": "claude-transcripts-sessions",   // the session corpus
      "appLogs":  "claude-transcripts-app-logs"    // operational logs (app-logging.md)
    }
  },
  "s3": {
    "buckets": {
      "sessions": "claude-transcripts-sessions"    // room for more buckets later
    }
  },
  "meilisearch": {
    "indexes": {
      "sessions": "claude-transcripts-sessions",   // session metadata
      "turns":    "claude-transcripts-turns"       // conversation content
    }
  },

  "features": {
    "s3Blobs": true,                 // upload transcript/summary blobs to S3
    "midFlightChunking": true,       // tail the transcript into CouchDB chunk docs during the session
    "couchFullContentChunks": true,  // embed parsed per-turn content in those chunks (ADR 0027)
    "meilisearch": true,             // full-text search over sessions + conversation content
    "secretsMasking": false          // mask secrets on write/read (future scope)
  },

  "servicesMenu": {                  // links shown in the webui Services menu
    "couchdbFauxton": "http://127.0.0.1:7652/_utils/",
    "garageWebui":    "http://127.0.0.1:7655/",
    "meilisearch":    "http://127.0.0.1:7656/"
  },

  "userSettings": {                  // reader tunables, served to the webui via /api/model
    "sessionListPageSize": 100,      // sessions fetched per page as the list scrolls
    "transcriptPageSize": 100,       // transcript entries fetched per page
    "transcriptAutoLoadMax": 2000    // entries the viewer loads on its own before it asks
  },

  "recall": {                        // when a live session consults its own history (ADR 0029)
    "mode": "auto",                  // off | suggest | auto
    "scope": "project",              // project | host | all — keep `project` while secretsMasking is off
    "maxResults": 5,
    "maxSnippetChars": 400,
    "triggers": {
      "priorWorkQuestion": true,     // "did we…", "why is this…", "what did we decide…"
      "repeatedError": true,         // an error that appears in past sessions
      "beforeRederiving": true       // about to redo something that looks like prior work
    },
    "excludeCwdGlobs": [],           // directories never recalled from, nor primed in
    "primer": { "onSessionStart": true, "maxTokens": 200 }
  }
}
```

> **Feature flags.** `midFlightChunking` + `couchFullContentChunks` +
> `system.logging.chunk.*` drive mid-flight transcript chunking
> ([mid-flight-chunking.md](../design/mid-flight-chunking.md),
> [ADR 0027](../design/decisions/0027-full-content-chunks-in-couchdb.md)). They now
> default **on**, and quite a lot depends on that: content chunks are what make a live
> session's transcript readable before it ends, what the speaker-split views map over,
> and what content search indexes. Turn `couchFullContentChunks` off and chunks carry
> byte ranges only — transcripts then read from S3 (so only after the session ends)
> and contribute nothing to search. `meilisearch` gates search entirely
> ([ADR 0009](../design/decisions/0009-meilisearch-search.md)); `secretsMasking`
> remains a placeholder. Re-run the CLI's `setup` after changing flags so the hook's
> runtime config is rebaked.

- **`system`** — core/dev-level constants and tunables (e.g. chunk buffer size).
- **`couchdb.databases` / `s3.buckets`** — **keyed maps**, not single names, so the
  app supports **multiple databases and buckets** (the app-logs DB is the first
  second database). Code refers to a store **by logical key** (`sessions`,
  `appLogs`), never a hard-coded name.
- **`userSettings`** — how much the webui pulls at a time. The two page sizes are the
  `limit` on one request to the gateway; `transcriptAutoLoadMax` is where the transcript
  viewer stops scrolling and prefetching on its own and offers a "Load the remaining N
  entries" button instead (nothing in the reader is virtualised yet, so the ceiling is
  what keeps a 40 000-entry session out of the DOM). Raise the page sizes on a fast host
  with a large corpus; lower them on a small one. Values are clamped
  (`resolveUserSettings`), and anything absent or nonsensical falls back to the default
  above rather than failing the build of the app model. Omit the section entirely for
  the defaults shown.
- **`recall`** — the recall policy, resolved by the app model (`model.recall`) and
  baked into the hook's runtime config; the plugin's `userConfig` (`recall_mode`,
  `recall_scope`, `max_results`) overrides it per user. Omit the section for the
  defaults shown. Re-run `setup` after changing it.
- **Secrets/endpoints** stay in `.env` (below): the bundled defaults are non-secret
  or empty ([ADR 0020](../design/decisions/0020-bundled-services-default-no-auth.md)), but
  `.env` always carries the **full endpoint paths** to CouchDB and S3.

## Who reads what

- **webapi** loads `config/` directly (`packages/webapi/src/config.ts`) for the DB and
  bucket names, feature flags, and service URLs, then overlays `.env`. The config is
  copied into the runtime image by the `Dockerfile`.
- **hook** can't resolve the workspace at install time, so the CLI's `setup` reads
  `config/` and **bakes** the names + `features` + `system.logging` into the generated
  runtime config at `~/.config/claude-transcripts/config.json` (alongside the secrets
  from `.env`). Re-run `setup` after editing `config/config.json` — the hook reads the
  baked copy, not the repo. Settings that are the *machine's* own rather than a
  projection of `config/` are carried across that rewrite instead of being regenerated;
  [`mirrors`](../operate/mirrors.md) is the one such key today.
- **docker-compose** uses `.env` only; its defaults mirror the committed template.

## Environment variables (`.env`)

See [`.env.template`](../../.env.template) — one file for both the host-run
webapi/webui/CLI and the Compose stack (the stack runner passes it through). The
secret/endpoint variables are: `COUCHDB_URL` (full base URL — wins over
`COUCHDB_HOST/PORT`), `COUCHDB_HOST/PORT/USER/PASSWORD/DB`,
`S3_ENDPOINT/REGION/ACCESS_KEY/SECRET_KEY/BUCKET`, and the webapi/webui
host/port settings.

## Backend topology — bundled or external

The app container is told **where** its backends live purely through env, so the
same image runs in two topologies ([containers.md](../operate/containers.md)):

- **Bundled** — the `deploy/` Docker Compose stack brings up CouchDB + Garage (S3)
  + Meilisearch locally; the env points at those localhost services (Tier 1
  default). The bundled services ask the operator to supply **no credentials of
  their own** — Meilisearch runs with no master key, Garage ships a pre-baked
  key, and CouchDB gets a fixed default admin (`admin`/`admin`), because CouchDB 3
  refuses to start without one. The stack binds to localhost only. Search and
  `S3_*` auth fields may be left empty for the bundled case; `COUCHDB_USER` /
  `COUCHDB_PASSWORD` must match whatever the CouchDB container was started with.
  See
  [ADR 0020](../design/decisions/0020-bundled-services-default-no-auth.md).
- **External** — run the app container alone with env pointing at remote services
  (e.g. managed CouchDB + **Cloudflare R2** + a hosted Meilisearch). Nothing in
  the image assumes localhost: each backend is addressed by a full URL —
  `COUCHDB_URL` (with `COUCHDB_USER`/`COUCHDB_PASSWORD`), `S3_ENDPOINT` +
  `S3_*` keys, `MEILI_HOST` + `MEILI_API_KEY` — so HTTPS and a path prefix
  (`https://couch.example.com/couchdb`) work for each. `COUCHDB_HOST`/`PORT`
  remain as the bundled-stack shorthand and are ignored when `COUCHDB_URL` is set.
  Resolution lives in one place (`resolveCouchUrl` in
  `@claude-transcripts/shared`) so the webapi, CLI, and seed script agree.

  **Not yet verified end to end** — the plumbing is in place, but no external
  deployment has been exercised; expect rough edges (bucket + key creation is
  manual, `bootstrap:garage` only targets the bundled Garage, and a CouchDB
  **path prefix** depends on how the nano client joins the database name onto
  the base URL — untested).

## Toggling optional components

Per [tiers.md](../design/tiers.md), several components are optional and switch off via
config, losing only their feature:

- **Meilisearch** — `features.meilisearch` (off ⇒ no search; or swap the backend,
  see [database-choice.md](../design/database-choice.md)).
- **S3 / Garage** — `features.s3Blobs` (off ⇒ no blob backups/escrow; CouchDB
  still persists data).
- **webui** — can be disabled without affecting the API/CLI.
- **Mid-flight chunking** — `features.midFlightChunking` / `couchFullContentChunks`.

## Services menu

`servicesMenu` lists the backing-service admin dashboards surfaced in the webui
(CouchDB Fauxton, Garage WebUI, Meilisearch). In the bundled stack these are
local; with external backends, point them wherever the services live. Making this
menu fully config-driven (rather than partly hard-coded in the webui today) is
tracked in [#14](../design/roadmap.md).

## Design goal: everything configurable

The intent is that **as much as possible is configurable** — names, feature
toggles, tunables, service URLs, and (per
[ADR 0017](../design/decisions/0017-hooks-and-actions-decoupled.md)) the hook→action
bindings — all flow from `claude-transcripts.config.json` (non-secret) + `.env` (secret), with
no second config source. New knobs extend this file rather than introducing
another.

## Search

Optional, on by default (`features.meilisearch`), and **local-only** in the bundled
stack: Meilisearch is published on `127.0.0.1:7656`, the same posture as the webapi.
Indexing happens **on your machine** — the webapi follows CouchDB's change feed and
writes to Meilisearch, both of them local; the hook never touches it. Turning the
feature off costs you the search box and nothing else, since every index is derived
from CouchDB and rebuildable with `claude-transcripts reindex`.

`install` creates and fills the indexes for you, and `doctor` checks that a session it
just wrote is findable — so a broken index shows up at setup rather than the first time
you search.

### Pointing at an external Meilisearch

`MEILI_HOST` (and `MEILI_API_KEY`, for an instance with a master key) can point anywhere
— but read [ADR 0028](../design/decisions/0028-external-vs-bundled-meilisearch.md)
first, because Meilisearch is unlike the other backing services.

⚠️ **The `turns` index holds conversation text.** An external Meilisearch is the one
configuration where this project's data leaves the machine it was recorded on.

CouchDB and Garage are **stores**: point at another one and the app works. Meilisearch
is a **derived index** this app configures, feeds, and rebuilds — and `reindex` clears
an index before repopulating it. That's safe only because the index names are
namespaced (`claude-transcripts-*`) and therefore ours. If you change them, keep them
distinct from anything else on that engine.

The bundled instance stays the default and the configuration we test.

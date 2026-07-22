# Configuration

There are two layers of configuration, split by sensitivity:

| Layer | File | Holds | Committed? |
|-------|------|-------|-----------|
| **Top-level settings** | `claude-transcripts.config.json` (repo root) | Non-secret, deployment-wide defaults: database/bucket names, feature flags, tunables, service-menu URLs | **Yes** — it's the single source of truth |
| **Secrets & endpoints** | `.env` (per machine) | Hosts, ports, credentials, S3 keys | **No** (`.gitignore`d) |

`.env` values **override** the matching `claude-transcripts.config.json` defaults. Anything
secret or per-deployment belongs in `.env`; anything stable and shareable belongs
in `claude-transcripts.config.json`.

## `claude-transcripts.config.json`

```jsonc
{
  "couchdb": { "database": "claude-sessions" },   // default DB name (env: COUCHDB_DB)
  "s3":      { "bucket":   "claude-sessions" },   // default bucket  (env: S3_BUCKET)

  "features": {
    "s3Blobs": true,                  // upload transcript/summary blobs to S3
    "midFlightChunking": false,       // tail the transcript into CouchDB chunk docs during the session (#4)
    "couchFullContentChunks": false,  // when chunking, store parsed entry content (vs light markers) (#4)
    "meilisearch": false,             // phase-2 full-text search (not wired up yet)
    "secretsMasking": false           // mask secrets on write/read (future scope)
  },

  "logging": {
    "chunk": { "maxEntriesPerChunk": 200, "flushIntervalMs": 15000 }  // (#4)
  },

  "servicesMenu": {                   // links shown in the webui Services menu
    "couchdbFauxton": "http://localhost:7652/_utils/",
    "garageWebui":    "http://localhost:7655/",
    "meilisearch":    "http://localhost:7656/"
  }
}
```

> `midFlightChunking` + `couchFullContentChunks` + `logging.chunk.*` drive the
> mid-flight transcript chunking from the logging rework (**issue #4**); see
> [`docs/mid-flight-chunking.md`](mid-flight-chunking.md). Both flags default `false` (exact prior
> behaviour); set `midFlightChunking: true` to tail the transcript into CouchDB
> `chunk:` docs during the session, and `couchFullContentChunks: true` to store
> the parsed entry content in those chunks (vs light offset/count markers). Re-run
> `hooks/scripts/setup.sh` after changing them so the hook runtime config is rebaked.
> `meilisearch` + `secretsMasking` remain **placeholders** (future scope).

## Structured config (Tier-1 target shape)

The config is being formalised into clearly-separated sections. **Target shape**
(the current flat keys keep working and are migrated into this):

```jsonc
{
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

  // NAMES — designed for MORE THAN ONE database and bucket from the start
  "couchdb": {
    "databases": {
      "sessions": "claude-sessions",   // the session corpus
      "appLogs":  "app-logs"           // operational logs (app-logging.md)
    }
  },
  "s3": {
    "buckets": {
      "sessions": "claude-sessions"    // room for more buckets later
    }
  },

  "features":     { /* toggles: s3Blobs, midFlightChunking, meilisearch, … */ },
  "servicesMenu": { /* admin-UI links */ },

  // USER settings — reserved, empty for now
  "userSettings": {}
}
```

- **`system`** — core/dev-level constants and tunables (e.g. chunk buffer size).
- **`couchdb.databases` / `s3.buckets`** — **keyed maps**, not single names, so the
  app supports **multiple databases and buckets** (the app-logs DB is the first
  second database). Code refers to a store **by logical key** (`sessions`,
  `appLogs`), never a hard-coded name.
- **`userSettings`** — placeholder for end-user preferences; empty in Tier 1.
- **Secrets/endpoints** stay in `.env` (below): the bundled defaults are non-secret
  or empty ([ADR 0020](decisions/0020-bundled-services-default-no-auth.md)), but
  `.env` always carries the **full endpoint paths** to CouchDB and S3.

> Migrating the flat `couchdb.database` / `s3.bucket` keys to the keyed maps (and
> updating `config.ts` to resolve by key) is part of the webapi scaffolding pass;
> the shape above is the contract it targets.

## Who reads what

- **webapi** imports `claude-transcripts.config.json` directly (`packages/webapi/src/config.ts`)
  for the default DB/bucket names, feature flags, and service URLs, then overlays
  `.env`. The repo-root file is copied into the runtime image by the `Dockerfile`.
- **hook** can't resolve the workspace at install time, so `hooks/scripts/setup.sh`
  reads `claude-transcripts.config.json` (via Bun) and **bakes** the names + `features` +
  `logging` into the generated runtime config at
  `~/.config/claude-transcripts/config.json` (alongside the secrets from
  `.env`). Re-run `setup.sh` (with `FORCE=1`) after editing `claude-transcripts.config.json`.
- **docker-compose** uses `.env` only; its defaults mirror `claude-transcripts.config.json`.

## Environment variables (`.env`)

See [`.env.example`](../.env.example) (root, for the webapi/dev) and
[`deploy/.env.example`](../deploy/.env.example) (for the bundled stack). The
secret/endpoint variables are: `COUCHDB_HOST/PORT/USER/PASSWORD/DB`,
`S3_ENDPOINT/REGION/ACCESS_KEY/SECRET_KEY/BUCKET`, and the webapi/webui
host/port settings.

## Backend topology — bundled or external

The app container is told **where** its backends live purely through env, so the
same image runs in two topologies ([containers.md](containers.md)):

- **Bundled** — the `deploy/` Docker Compose stack brings up CouchDB + Garage (S3)
  + Meilisearch locally; the env points at those localhost services (Tier 1
  default). The bundled services default to **no auth** — no tokens/keys/passwords
  for the operator to supply (CouchDB open, Meilisearch no master key, Garage with
  a pre-baked default key); the stack binds to localhost only. The `COUCHDB_*` /
  `S3_*` / search auth fields may be left empty for the bundled case. See
  [ADR 0020](decisions/0020-bundled-services-default-no-auth.md).
- **External** — run the app container alone with env pointing at remote services
  (e.g. managed CouchDB + **Cloudflare R2** + a hosted Meilisearch). Nothing in
  the image assumes localhost; S3 is reached vendor-neutrally via `S3_*`.

## Toggling optional components

Per [tiers.md](tiers.md), several components are optional and switch off via
config, losing only their feature:

- **Meilisearch** — `features.meilisearch` (off ⇒ no search; or swap the backend,
  see [database-choice.md](database-choice.md)).
- **S3 / Garage** — `features.s3Blobs` (off ⇒ no blob backups/escrow; CouchDB
  still persists data).
- **webui** — can be disabled without affecting the API/CLI.
- **Mid-flight chunking** — `features.midFlightChunking` / `couchFullContentChunks`.

## Services menu

`servicesMenu` lists the backing-service admin dashboards surfaced in the webui
(CouchDB Fauxton, Garage WebUI, Meilisearch). In the bundled stack these are
local; with external backends, point them wherever the services live. Making this
menu fully config-driven (rather than partly hard-coded in the webui today) is
tracked in [#14](roadmap.md).

## Design goal: everything configurable

The intent is that **as much as possible is configurable** — names, feature
toggles, tunables, service URLs, and (per
[ADR 0017](decisions/0017-hooks-and-actions-decoupled.md)) the hook→action
bindings — all flow from `claude-transcripts.config.json` (non-secret) + `.env` (secret), with
no second config source. New knobs extend this file rather than introducing
another.

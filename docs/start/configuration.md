# Configuration

Two layers:

| Layer | File | Holds |
|-------|------|-------|
| Settings | `config/config.json` in a checkout (falls back to the committed `config/config.template.json`); `~/.config/claude-transcripts/app.json` on an installed instance | Non-secret: store names, feature flags, tunables, service-menu URLs, recall policy |
| Secrets and endpoints | `.env` in a checkout ([`.env.template`](../../.env.template)); `~/.config/claude-transcripts/instance.env` on an installed instance | Hosts, ports, credentials, S3 keys, image tags |

Both live files are gitignored. New knobs go into `config/`, not a third source.

**After changing settings, re-run `install` (or `setup` in a checkout).** The hook
does not read `config/` or `app.json`; it reads a runtime config at
`~/.config/claude-transcripts/config.json` that `install`/`setup` generate from them.

## Settings

The committed template:

```jsonc
{
  "app": { "name": "claude-transcripts" },
  "system": {
    "logging": { "chunk": { "maxEntriesPerChunk": 200, "flushIntervalMs": 15000 } },
    "sessions": { "liveWindowMs": 86400000, "idleThresholdMs": 300000 }
  },
  "couchdb": {
    "databases": {
      "sessions": "claude-transcripts-sessions",
      "appLogs":  "claude-transcripts-app-logs"
    }
  },
  "s3": { "buckets": { "sessions": "claude-transcripts-sessions" } },
  "meilisearch": {
    "indexes": {
      "sessions": "claude-transcripts-sessions",
      "turns":    "claude-transcripts-turns"
    }
  },
  "features": {
    "s3Blobs": true,
    "midFlightChunking": true,
    "couchFullContentChunks": true,
    "meilisearch": true,
    "secretsMasking": false
  },
  "servicesMenu": {},
  "userSettings": {
    "sessionListPageSize": 100,
    "transcriptPageSize": 100,
    "transcriptAutoLoadMax": 2000
  },
  "recall": {
    "mode": "auto",
    "scope": "project",
    "maxResults": 5,
    "maxSnippetChars": 400,
    "triggers": { "priorWorkQuestion": true, "repeatedError": true, "beforeRederiving": true },
    "excludeCwdGlobs": [],
    "primer": { "onSessionStart": true, "maxTokens": 200 }
  }
}
```

| Key | Meaning |
|-----|---------|
| `system.logging.chunk` | Mid-session chunk flush: after this many transcript entries or this many ms, whichever first ([mid-flight-chunking.md](../design/mid-flight-chunking.md)). |
| `system.sessions.liveWindowMs` | A session with no `SessionEnd` counts as `running` for this long after its last event (24 h), then `incomplete`. A recency heuristic; there is no heartbeat. |
| `system.sessions.idleThresholdMs` | Gaps between events longer than this (5 min) don't count towards a session's active time. |
| `couchdb.databases`, `s3.buckets`, `meilisearch.indexes` | Keyed maps: code refers to a store by logical key (`sessions`, `appLogs`, `turns`), never by its deployed name. The `claude-transcripts-` prefix keeps them from colliding with anything else on a shared server. |
| `features.s3Blobs` | Upload the transcript and a `summary.json` copy to S3. Off: no byte-exact transcript is kept anywhere; CouchDB still has the pruned per-turn content if full-content chunks are on. |
| `features.midFlightChunking` | Tail the transcript into CouchDB `chunk` docs during the session. |
| `features.couchFullContentChunks` | Put the parsed turns in those chunks ([ADR 0027](../design/decisions/0027-full-content-chunks-in-couchdb.md)). Off: a live session's transcript can't be read until it ends, the speaker-split views are empty, and conversation content isn't searchable. |
| `features.meilisearch` | Full-text search. Off: no search, nothing else changes. |
| `features.secretsMasking` | Placeholder; nothing is masked yet. |
| `servicesMenu` | Admin-UI links in the webui (keys `couchdbFauxton`, `garageWebui`, `meilisearch`, `meilisearchUi`; any other key is an extra link). Unset keys are derived as `http://127.0.0.1:<host port>`; set one when the dashboards live elsewhere, e.g. `{ "couchdbFauxton": "https://couch.example.org/_utils/" }`. |
| `userSettings` | How much the webui fetches: page sizes per request, and how many transcript entries load before the viewer offers a "load the rest" button (the list isn't virtualised). Out-of-range values fall back to the defaults. |
| `recall` | When a live session consults its own history ([ADR 0029](../design/decisions/0029-recall-policy-config-driven-session-start.md)). `mode`: `off`/`suggest`/`auto`; `scope`: `project`/`host`/`all`. Keep `scope: project` while `secretsMasking` is off. The plugin's `recall_mode`, `recall_scope` and `max_results` options override it per user. |

Omit a section to get its defaults.

## Who reads what

- **webapi** reads `config/` (`CT_CONFIG_DIR` overrides the directory) and overlays
  the environment. The app image bakes in the template; mount a file at
  `/app/config/config.json` to change it. An installed instance's `app.json` is read
  by the CLI and hook, not by the app container.
- **hook** reads only its runtime config (`CT_HOOK_CONFIG` overrides the path).
  `install`/`setup` regenerate it from settings + secrets, but keep two keys that are
  the machine's own: `mirrors` ([mirrors.md](../operate/mirrors.md)) and `webapi.url`.
- **CLI** finds the webapi from `--webapi`, then `CT_WEBAPI_URL`, then `WEBAPI_PORT`,
  then `webapi.url` in the hook runtime config, then the installed instance's port,
  then `127.0.0.1:7650`. On a machine that records to a remote deployment, set
  `webapi.url` (or `CT_WEBAPI_URL`) so reads go where the hook writes.
- **Docker Compose** reads `.env` / `instance.env` only.

Other variables: `CT_HOME` relocates a whole install (see
[installation.md](installation.md#where-things-live)); the app image sets
`CT_STATIC_DIR`, `CT_DOCS_DIR`, `CT_CLI_BIN` and `CT_VERSION`.

## Backend topology — bundled or external

The app finds its backends purely through the environment, so the same image runs
either way.

**Bundled** (default, the tested path): the `deploy/` Compose stack runs CouchDB,
Garage and Meilisearch on localhost. Meilisearch has no master key unless you ask for
one; Garage's app key is minted by `install` (or `bun run bootstrap:garage`) and
written to the env file; CouchDB gets a fixed `admin`/`admin` because CouchDB 3 will
not start without an admin ([ADR 0020](../design/decisions/0020-bundled-services-default-no-auth.md)).

**External**: point the app at your own services.

| Backend | Variables |
|---------|-----------|
| CouchDB | `COUCHDB_URL` (full base URL, https and a path prefix allowed; wins over `COUCHDB_HOST`/`COUCHDB_PORT`), `COUCHDB_USER`, `COUCHDB_PASSWORD` |
| S3 | `S3_ENDPOINT`, `S3_REGION`, `S3_ACCESS_KEY`, `S3_SECRET_KEY` (Garage, MinIO, R2, AWS) |
| Meilisearch | `MEILI_HOST`, `MEILI_API_KEY` |

Not verified end to end. Create the bucket and key yourself (`bootstrap:garage` only
targets the bundled Garage; the app never creates buckets), and a CouchDB path prefix
is untested.

### An external Meilisearch

Read [ADR 0028](../design/decisions/0028-external-vs-bundled-meilisearch.md) first.
The `turns` index holds conversation text, so an external Meilisearch is the one
configuration where recorded content leaves the machine. And Meilisearch is a derived
index the app owns: `reindex` clears an index before refilling it, which is safe only
because the index names are ours. If you rename them, keep them distinct from anything
else on that engine.

Search is otherwise local: the webapi follows CouchDB's change feed and writes to
Meilisearch; the hook never touches it. Every index can be rebuilt from CouchDB with
`claude-transcripts reindex`.

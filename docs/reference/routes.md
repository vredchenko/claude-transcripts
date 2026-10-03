# HTTP routes

Everything is served by the webapi under one origin
([ADR 0002](../design/decisions/0002-single-combined-container.md)). Parameters and
response shapes for the typed `/api` routes are in the OpenAPI spec, browsable at
`/api/docs` ([webapi.md](webapi.md#http-api)).

| Path | Serves |
|------|--------|
| `/` | JSON app manifest for agents and tools: identity and version, routes, services and ports, store keys, feature flags, services menu, recall policy, wired hooks, API summary ([ADR 0022](../design/decisions/0022-root-route-is-a-machine-readable-manifest.md)). Not a UI page. |
| `/health` | Liveness (always 200 while up) plus store and session-index readiness in the body ([webapi.md](webapi.md#health)). What `install` polls. |
| `/api/sessions`, `/api/sessions/{id}` | Session list (filters, paging) and detail. |
| `/api/sessions/{id}/transcript` | The transcript, from chunk docs or S3, whichever covers more ([webapi.md](webapi.md#transcripts)). |
| `/api/sessions/{id}/turns` | One session's turns, optionally one speaker (`?role=`). Empty without full-content chunks. |
| `/api/turns` | One speaker's turns across all sessions in time order (`role`, `from`, `to`, `limit`, `skip`). |
| `/api/search` | Full-text search: session metadata hits and conversation-turn hits. Returns `enabled: false` when Meilisearch is off or unreachable. |
| `POST /api/search/reindex` | Clear and rebuild both search indexes from CouchDB. |
| `/api/ingest/*` | The write surface: `POST summary`, `POST events`, `POST chunks`, `PUT {id}/transcript`, `DELETE {id}` (`?blobs=true` also deletes the transcript). Used by `backfill`, `import`, `doctor` and mirrors; the hook bypasses it. |
| `/api/migrate/*` | `GET status`, `POST up`, `POST down` ([migrations.md](../operate/migrations.md)). |
| `/api/model`, `/api/model/{services,hooks,actions,env}` | The app model, or one facet of it. |
| `/api/couch/*` | Read-only passthrough to CouchDB's HTTP API (docs, views). |
| `/api/s3/{bucketKey}/*` | Read-only object reads by logical bucket key, e.g. `/api/s3/sessions/<id>/transcript.jsonl`. |
| `/api/docs`, `/api/openapi.json` | Scalar API reference and the OpenAPI spec. |
| `/app` | The webui, when `CT_STATIC_DIR` is set. |
| `/docs` | These docs as HTML, when `CT_DOCS_DIR` is set. |
| `/cli/download` | The bundled CLI binary, when `CT_CLI_BIN` is set. |

The app image sets all three `CT_*` variables. Writes are never proxied to the stores.

The backing services' admin UIs (Fauxton, Garage web UI, Meilisearch UI) are not served
by the app; they are reached on their own ports and linked from the webui's menu
([`servicesMenu`](../start/configuration.md#settings)).

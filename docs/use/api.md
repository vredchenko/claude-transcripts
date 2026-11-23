# The API

Everything the web UI and the CLI show comes from one HTTP API on the instance's
origin, `http://127.0.0.1:7650` on a default install. Scripts and agents can read the
same thing directly.

There is no authentication yet: whoever can reach the instance can read all of it. The
bundled instance listens on localhost only, so that is a decision you make when you
put something in front of it ([HTTPS](../operate/https.md)).

## Finding your way

| Start at | For |
|----------|-----|
| `/api/docs` | A browsable reference for every typed route, with parameters and response shapes. |
| `/api/openapi.json` | The same as an OpenAPI spec, to generate a client from. |
| `/` | A JSON description of the instance for agents and tools: version, routes, services, feature flags, recall policy. |
| `/health` | Always `200` while the process is up; the body says whether the stores are usable. |

## Reading history

```bash
curl -s 'http://127.0.0.1:7650/api/sessions?limit=5'
curl -s 'http://127.0.0.1:7650/api/sessions/<id>'
curl -s 'http://127.0.0.1:7650/api/sessions/<id>/transcript?limit=50'
curl -s 'http://127.0.0.1:7650/api/search?q=retry+policy'
```

| Route | Returns |
|-------|---------|
| `GET /api/sessions` | The session list. Filters: `cwd`, `model`, `hostname`, `source`, `status` (exact), `from` / `to` (ISO instants, by overlap). Paging: `limit`, `skip`. |
| `GET /api/sessions/{id}` | One session: metadata, counts, token usage. |
| `GET /api/sessions/{id}/transcript` | The transcript as parsed entries, paged with `limit` / `offset`. Readable while the session is still running. |
| `GET /api/sessions/{id}/turns` | That session's turns, optionally one speaker (`role`). |
| `GET /api/turns` | One speaker's turns across all sessions in time order (`role`, `from`, `to`, `limit`, `skip`). |
| `GET /api/search` | Full-text [search](search.md): `q`, the same filters, `limit`, `offset`. |

The full list of routes is in the [routes reference](../reference/routes.md), and the
behaviour behind them (how status is derived, where a transcript is read from, how
fresh search is) in the [webapi reference](../reference/webapi.md).

## The raw stores, read-only

Two passthroughs expose the stores' own read APIs, for the questions the typed routes
don't answer:

- `/api/couch/*` is CouchDB's HTTP API: documents and views. What is stored, and which
  views exist, is in [CouchDB documents and views](../reference/couchdb.md).
- `/api/s3/{bucketKey}/*` reads stored files by logical bucket key. The exact
  transcript Claude Code wrote, byte for byte, is at
  `/api/s3/sessions/<id>/transcript.jsonl`.

Both accept `GET` and `HEAD` only.

## Writing

Nothing writes to the stores except through `/api/ingest/*`, and those routes exist
for the recorder: the hook, `backfill`, `import` and `doctor`. To put sessions into an
instance, use those commands; they keep the documents consistent with each other.

## For agents

An agent with a shell is usually better served by the CLI: `claude-transcripts
sessions`, `search` and `turns` with `--json` print these same responses and already
know which instance to talk to ([From the terminal](terminal.md)). That is what the
plugin's skills use ([In Claude Code](in-claude-code.md#with-the-plugin)).

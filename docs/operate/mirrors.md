# Mirrors

A mirror is a second instance that receives every session as it is recorded, alongside
the local one: a laptop that also reports to a home server, several machines feeding
one archive, or a local instance in front of a remote system of record.

## Configuring one

Add `mirrors` to the hook runtime config (`~/.config/claude-transcripts/config.json`,
[hook-setup.md](../start/hook-setup.md)):

```json
{
  "couch": { "url": "http://127.0.0.1:7652", "databases": { "sessions": "..." } },
  "blob":  { "endpoint": "http://127.0.0.1:7653", "buckets": { "sessions": "..." } },
  "mirrors": [
    { "url": "https://logs.example.com", "timeoutMs": 2000, "blobTimeoutMs": 60000 }
  ]
}
```

| Field | Default | Meaning |
|---|---|---|
| `url` | — | Base URL of the mirror's webapi. |
| `timeoutMs` | `2000` | Cap on each per-event write. |
| `blobTimeoutMs` | `60000` | Cap on the transcript upload at `SessionEnd`. |
| `auth` | none | `user:password` if the mirror is behind basic auth. |

Every mirror in the array gets every write. No re-registration is needed; sessions
already running keep the config they started with. `install` and `setup` preserve
`mirrors` when they regenerate the file; edit the key to change or remove it.

Check it:

```console
$ claude-transcripts hook status
hook: settings   ~/.claude/settings.json
hook: config     ~/.config/claude-transcripts/config.json
hook: command    /usr/local/bin/claude-transcripts hook run
hook: mirror     https://logs.example.com
hook: registered for 11 event(s), mirroring to 1
```

## How it works

The hook writes this machine's CouchDB and S3 directly. A remote instance exposes only
its webapi, whose store proxies are read-only, so a mirror writes through the one write
surface it has, `/api/ingest` (the same routes `import` uses):

| Written locally | Sent to the mirror as |
|---|---|
| `event` doc | `POST /api/ingest/events` |
| `chunk` doc | `POST /api/ingest/chunks` |
| `summary` doc | `POST /api/ingest/summary` |
| `<session>/transcript.jsonl` | `PUT /api/ingest/<session>/transcript` |
| `<session>/summary.json` | not sent (a copy of the summary doc) |

The mirror applies its own database and bucket names. It is a write path only; the CLI
and webui keep reading the local instance.

The timeouts are sized to Claude Code's hook limits: `PostToolUse` runs on every tool
call within a 5-second budget, so a dead mirror must give up well inside it, while the
transcript upload happens in `SessionEnd`'s 180-second budget.

## Failure behaviour

A mirror never blocks a session or slows the local write: requests run in parallel with
the local write, each has its own timeout, and every failure is swallowed.

**There is no retry and no queue.** Writes that fail while the mirror is unreachable
are lost to the mirror; the local copy is complete. Fill the gap from the local
instance:

```bash
claude-transcripts export ./gap --since 2026-01-01T00:00:00Z
claude-transcripts import ./gap --webapi https://logs.example.com
```

Import is idempotent, so a range wider than the gap is harmless. To find gaps, compare
session lists:

```bash
ids() { curl -s "$1/api/sessions?limit=1000" | jq -r '.sessions[].sessionId' | sort; }
ids http://127.0.0.1:7650    > local.txt
ids https://logs.example.com > mirror.txt
comm -23 local.txt mirror.txt    # recorded locally, missing from the mirror
```

Two silent failure modes:

- **Schema mismatch.** The mirror validates against its own schema and may reject
  documents from a newer hook. If a mirror looks empty, compare `/api/migrate/status`
  on both.
- **Older binaries ignore `mirrors`.** Downgrading to a release without mirror support
  leaves the key in place and stops mirroring without a warning.

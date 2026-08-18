# Mirrors — writing sessions to more than one instance

A mirror is a second instance that receives the same session history as the local one,
live, as it is recorded. Configure one and every hook event is written twice: to this
machine's stores as before, and to the mirror.

The use case is a machine that records locally but also reports into a shared or
long-lived instance elsewhere — a laptop that keeps its own copy while everything also
lands on a home server, several machines feeding one archive, or a local instance kept
as the fast read path in front of a remote system of record.

## Why a mirror is not just another `couch.url`

The hook writes straight to CouchDB and S3, deliberately, so that recording a session
never depends on a webapi being up
([ADR 0016](../design/decisions/0016-webapi-is-the-io-gateway.md#amendment-the-hook-is-a-second-writer)).
That works because those stores are *this machine's*: bound to localhost, no round trip
worth worrying about.

A remote instance breaks the assumption in a way no amount of configuration fixes. Its
CouchDB and S3 are bound to *its* localhost and are not reachable from anywhere else;
the only thing it exposes is the webapi, and the webapi's `/api/couch` and `/api/s3`
proxies are read-only by design. So a mirror cannot be expressed as a second set of
store credentials. It has to go through the one write surface a remote instance
actually offers: **`/api/ingest`**.

That is the same surface `import` uses to restore a bundle
([bundles.md](../design/bundles.md)), so the document shapes are already known to
travel. A mirror is, in effect, a live and incremental `import`.

## Configuring one

In the hook's runtime config (`~/.config/claude-transcripts/config.json` — see
[hook-setup.md](../start/hook-setup.md)), add a `mirrors` array alongside the existing
`couch` and `blob` blocks:

```json
{
  "couch": { "url": "http://127.0.0.1:7660", "databases": { "sessions": "..." } },
  "blob":  { "endpoint": "http://127.0.0.1:7661", "buckets": { "sessions": "..." } },
  "mirrors": [
    {
      "url": "https://logs.example.com",
      "timeoutMs": 2000,
      "blobTimeoutMs": 60000
    }
  ]
}
```

| Field | Default | What it is |
|---|---|---|
| `url` | — | Base URL of the mirror instance. A trailing slash is fine. |
| `timeoutMs` | `2000` | Cap on an ordinary per-event write. |
| `blobTimeoutMs` | `60000` | Cap on the end-of-session transcript upload. |
| `auth` | none | `user:password` if the mirror sits behind basic auth. |

The array takes more than one entry; every mirror gets every write.

No re-registration is needed. All hook events invoke the same binary against this one
config, so adding `mirrors` covers every event at once. Sessions already running keep
the config they started with — Claude Code snapshots hook settings at session start.

### Choosing the timeouts

`timeoutMs` is short on purpose. `PostToolUse` fires on every tool call and Claude Code
gives that hook five seconds in total, so a mirror that has gone away must give up well
inside that budget. Two seconds leaves room for the local write and process startup and
is slow enough to tolerate an ordinary internet round trip.

`blobTimeoutMs` is generous because it applies only at `SessionEnd` — a 180-second hook
— and a long session's transcript runs to megabytes.

## What travels

| Written locally | Mirrored as |
|---|---|
| `event` doc | `POST /api/ingest/events` |
| `chunk` doc | `POST /api/ingest/chunks` (id moved into the body) |
| `summary` doc | `POST /api/ingest/summary` |
| `<session>/transcript.jsonl` | `PUT /api/ingest/<session>/transcript` |
| `<session>/summary.json` | **not mirrored** |

The chunk id moves from the URL into the document because that is what ingest reads it
from, and it is what makes a re-flush replace rather than duplicate. `summary.json` is
skipped because ingest has no endpoint for it and it is only a convenience copy of a
document that is itself mirrored — the same call `import` makes.

## Failure behaviour, and the gap it leaves

A mirror never blocks a session and never degrades the primary:

- Every request is bounded by its own timeout, and every failure is swallowed.
- Fan-out writes start together rather than in sequence, so the local store is never
  queued behind a remote one. An event costs `max(local, mirror)`, not the sum.
- An unreachable mirror costs one timeout per event, not a session.

**There is no retry and no queue.** This is the limitation to plan around: a write that
fails while the mirror is down is *lost to the mirror*, not deferred. The local copy is
unaffected and remains complete, so nothing is lost outright — but the mirror will hold
a hole covering the outage.

Backfill a gap from the local instance, which still has everything:

```bash
claude-transcripts export ./gap --since 2026-01-01T00:00:00Z
claude-transcripts import ./gap --webapi https://logs.example.com
```

Import is idempotent — documents carry their source id, so re-importing across a range
wider than the gap conflicts benignly rather than duplicating. Widening the range is
the cheap way to be sure you covered it.

Check for holes by comparing session counts, or diffing the session lists:

```bash
ids() { curl -s "$1/api/sessions?limit=1000" | jq -r '.sessions[].sessionId' | sort; }
ids http://127.0.0.1:7650      > local.txt
ids https://logs.example.com   > mirror.txt
comm -23 local.txt mirror.txt      # recorded locally, missing from the mirror
```

## Things worth knowing

- **A mirror is a write path, not a read path.** Nothing on this machine reads from the
  mirror; the CLI and webui keep reading the local instance.
- **Mirror and primary need not agree on names.** Writes go through the mirror's own
  gateway, so it applies its own database and bucket names. A mirror whose database is
  called something else is fine.
- **Schema versions should match.** Ingest validates against the mirror's own schema. A
  mirror running an older build may reject documents a newer hook sends; the failure is
  silent by design, so check `/api/migrate/status` on both when a mirror looks empty.
- **`mirrors` is ignored by a build that predates it.** Downgrading, or reinstalling a
  release without mirror support, leaves the config key in place and simply stops
  mirroring — it does not error, and it does not warn.

# Mirrors

A mirror is a second instance that receives every session as it is recorded, alongside
the local one: a laptop that also reports to a home server, several machines feeding
one archive, or a local instance in front of a remote system of record.

## Configuring one

Add `mirrors` to the hook runtime config (`~/.config/claude-transcripts/config.json`,
[hook-setup.md](../start/hook-setup.md)):

```json
{
  "webapi": { "url": "http://127.0.0.1:7650" },
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

A mirror is always *another* instance. An entry whose URL is the config's own
`webapi.url` (compared ignoring case, a trailing slash and a default port) would
receive every write twice, so the hook skips it, `setup` and `install` drop it, and
`hook status` and `doctor` flag it. Configs written before v0.11 often have one, left
from when the mirror was the hook's only webapi write.

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

The hook writes only through a webapi's ingest routes
([ADR 0016](../design/decisions/0016-webapi-is-the-io-gateway.md#amendment-2-the-hook-writes-through-the-webapi)),
so a mirror is simply a second webapi it writes to, over the same client and the same
routes `import` uses:

| Written | Route, on the instance and on each mirror |
|---|---|
| `event` doc | `POST /api/ingest/events` |
| `chunk` doc | `POST /api/ingest/chunks` |
| `summary` doc | `POST /api/ingest/summary` |
| `<session>/transcript.jsonl` | `PUT /api/ingest/<session>/transcript` |

The mirror applies its own database and bucket names. It is a write path only; the CLI
and webui keep reading the local instance.

The timeouts are sized to Claude Code's hook limits: `PostToolUse` runs on every tool
call within a 5-second budget, so a dead mirror must give up well inside it, while the
transcript upload runs in a detached process after `SessionEnd` returns, with a
minute (`blobTimeoutMs`) of its own.

## Failure behaviour

A mirror never blocks a session or slows the instance's write: requests run in parallel
with it, each has its own timeout, and no failure is thrown. Each target's health is
tracked separately, so the statusline can show `rec (mirror)` when only a mirror is
taking writes, and `stalled` (with the reason) when none is.

**There is no retry and no queue.** Writes that fail while the mirror is unreachable
are lost to the mirror; the instance's copy is complete. Fill the gap from the
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

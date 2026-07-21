# Claude Transcripts

> **Codename:** `claude-transcripts` · **Slug:** `claude-transcripts` · **Title:** Claude Transcripts

**Self-hosted history for your [Claude Code](https://claude.com/claude-code)
sessions.** A Claude Code hook logs every session — events, an end-of-session
summary (counts, tool usage, token usage), and the full transcript — to your own
**CouchDB** + **S3-compatible** storage. A web API serves it back; a web UI and a
CLI (and AI agents) read it.

Everything runs on your own infrastructure. Nothing leaves your network.

```
Claude Code ──hook──► webapi ──► CouchDB + S3        webui ─┐
                        ▲                             cli  ──┼─► webapi
                        └───────── reads/writes ──────agents┘
```

## Components

| Component | Path | Role |
|-----------|------|------|
| **hooks** | `hooks/` | Claude Code plugin (writer). Logs sessions; installs per machine. |
| **webapi** | `packages/webapi/` | Bun + Hono gateway: the single I/O surface; serves the SPA in prod. |
| **webui** | `packages/webui/` | React + MUI SPA (optional). |
| **cli** | `packages/cli/` | Bun + Ink user-facing tool + admin utility (optional). |
| **shared** | `packages/shared/` | Cross-cutting types + token accounting. |
| **scripts** | `scripts/` | Dev-only automation (client gen, image mirroring, release). |
| **deploy** | `deploy/` | Docker Compose: CouchDB + Garage + Meilisearch + admin UIs. |

## Status

Early rebuild. Tier 1 (single machine, single user) first. See
[`docs/`](docs/) for the technical design, and [`CLAUDE.md`](CLAUDE.md) for the
build conventions.

## Configuration

Non-secret deployment-wide settings live in [`config/`](config/) (copy
[`config/config.template.json`](config/config.template.json) → `config/config.json`);
secrets/endpoints in a local `.env` (copy [`.env.template`](.env.template)). The
bundled dev stack runs on ports `7650–7661` with no auth on localhost.

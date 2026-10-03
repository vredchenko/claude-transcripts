# Claude Transcripts documentation

Self-hosted history for [Claude Code](https://claude.com/claude-code) sessions. A hook
records every session to your own CouchDB and S3-compatible storage; a web API serves
it back to a web UI, a CLI and agents. Nothing leaves your machine unless you point it
at services elsewhere.

> **Work in progress, not tested as ready for use.** Breaking changes land without
> notice, stored data may need discarding between versions, and there is no auth:
> it assumes one user on one trusted machine.

```sh
curl -fsSL https://raw.githubusercontent.com/vredchenko/claude-transcripts/main/install.sh | sh
```

| To... | Read |
|-------|------|
| install it | [Installation](start/installation.md) |
| change ports, stores, feature flags | [Configuration](start/configuration.md) |
| wire the hook by hand | [Hook setup](start/hook-setup.md) |
| use the CLI | [CLI reference](reference/cli.md) |
| back up, restore, mirror | [Migrations, export and import](operate/migrations.md), [Mirrors](operate/mirrors.md) |
| work on the code | [Getting started (development)](develop/getting-started.md) |
| understand how it fits together | [Architecture](design/architecture.md), [ADRs](design/decisions/README.md) |

The same tree is published at
[vredchenko.github.io/claude-transcripts/docs](https://vredchenko.github.io/claude-transcripts/docs/)
and served by every instance at `/docs`.

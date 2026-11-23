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
| know what the banner and statusline are telling you | [In Claude Code](use/in-claude-code.md) |
| browse and search your history | [The web UI](use/web-ui.md), [Search](use/search.md) |
| script against it, or point an agent at it | [From the terminal](use/terminal.md), [The API](use/api.md) |
| open it from your phone, install it as an app | [HTTPS and installing the web UI](operate/https.md) |
| back up, restore, mirror | [Migrations, export and import](operate/migrations.md), [Mirrors](operate/mirrors.md) |
| adopt sessions from before you installed | [Backfill](operate/tools.md) |
| look up a command, route or stored document | [CLI](reference/cli.md), [HTTP routes](reference/routes.md), [CouchDB documents](reference/couchdb.md) |
| understand how it fits together | [Architecture](design/architecture.md) |
| work on the code | [Contributor docs](develop/README.md) |

These pages, the ones for people running Claude Transcripts, are published at
[vredchenko.github.io/claude-transcripts/docs](https://vredchenko.github.io/claude-transcripts/docs/)
and served by every instance at `/docs`. The contributor docs are read in the
repository.

# Claude Transcripts — documentation

Self-hosted history for your [Claude Code](https://claude.com/claude-code)
sessions. A hook logs every session to your own CouchDB + S3; a web API serves it
back; a web UI, a CLI, and agents read it. Nothing leaves your network.

> **Work in progress — not tested as ready for use.** No installation has been
> walked end to end on a clean machine. Breaking changes land without notice,
> stored data may need discarding between revisions, and there is no auth or
> security model (Tier 1 assumes one user on one trusted machine). These docs
> describe the intended design as much as the current state.

## Start here

| If you want to… | Go to |
|-----------------|-------|
| **Run it** on your machine | [Installation](start/installation.md) |
| **Configure** it — ports, stores, feature flags | [Configuration](start/configuration.md) |
| **Record sessions** — install the hook | [Hook setup](start/hook-setup.md) |
| **Work on it** | [Getting started (development)](develop/getting-started.md) |
| **Release, run, migrate** it | [Releasing](operate/releasing.md) |
| **Understand** the shape and the reasoning | [Specification](design/specification.md) · [Architecture](design/architecture.md) · [ADRs](design/decisions/README.md) |

## How these docs are organised

- **[Getting started](start/installation.md)** — installing, configuring, and
  recording your first session. Written for someone running the project.
- **[Development](develop/getting-started.md)** — setup, conventions, tests, and
  the generators. Written for someone changing the code.
- **[Operations](operate/releasing.md)** — releasing, containers, migrations, and
  application logging.
- **[Reference](reference/webapi.md)** — per-component and per-surface detail:
  webapi, webui, CLI, the hook, routes, CouchDB documents.
- **[Design & specification](design/specification.md)** — what the system is meant
  to be, the tier model, the roadmap, and the technology choices.
- **[Decisions](design/decisions/README.md)** — one ADR per architectural
  decision, nested under design.

Technical design is treated as a first-class deliverable here. This is a fresh
rebuild: the design set was re-written rather than copied from the predecessor
project, with naming, ports, paths, and reversed decisions reconciled to this
repo's conventions.

The published site at
[vredchenko.github.io/claude-transcripts/docs](https://vredchenko.github.io/claude-transcripts/docs/)
renders the same tree with this structure as its navigation, and its index lists
every page — generated from what actually shipped, so it can't drift.

## Conventions

Naming, components, ports, and stack conventions are in
[conventions.md](develop/conventions.md). Repo-level rules for agents working in
this codebase are in [`CLAUDE.md`](../CLAUDE.md).

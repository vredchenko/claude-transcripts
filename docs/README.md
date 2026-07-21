# Documentation — Claude Transcripts

> **Codename** `claude-transcripts` · **slug** `claude-transcripts` · **title** Claude Code
> Sessions History.

Technical design lives here as a first-class deliverable. This is a fresh rebuild —
the design set was (re)written here, adapted from the predecessor project rather
than blindly copied: naming, ports, paths, and reversed decisions are reconciled
to this repo's conventions.

## Conventions

See [conventions.md](conventions.md) — naming, components, ports, stack.

## Overview & scope

| Doc | Covers |
|-----|--------|
| [specification.md](specification.md) | What the system is, end to end |
| [architecture.md](architecture.md) | Gateway model, data model, storage split |
| [tiers.md](tiers.md) | Tier 1 / 2 / 3 feature model |
| [roadmap.md](roadmap.md) | What's built, what's next |
| [database-choice.md](database-choice.md) · [competitive-landscape.md](competitive-landscape.md) | Why CouchDB; how this compares to alternatives |

## Components

| Doc | Covers |
|-----|--------|
| [webapi.md](webapi.md) · [webui.md](webui.md) · [cli.md](cli.md) | Per-component references |
| [hook-events.md](hook-events.md) | **Authoritative catalogue** of every Claude Code hook event — when it fires, payload, fixtures, what we do (generated from the model) |
| [hook.md](hook.md) · [hooks.md](hooks.md) · [actions.md](actions.md) | The writer: hook mechanics, the hook→action binding model, the action catalogue |
| [routes.md](routes.md) | webapi route surface |

## Data & storage

| Doc | Covers |
|-----|--------|
| [couchdb-documents.md](couchdb-documents.md) | Catalogue of every CouchDB document type — purpose, ids, key fields |
| [couchdb.md](couchdb.md) | Document schemas (deep), status model & design views |
| [migrations.md](migrations.md) | Self-built CouchDB migrations |
| [mid-flight-chunking.md](mid-flight-chunking.md) | Live transcript chunking into CouchDB (deferred-ADR design note) |
| [app-logging.md](app-logging.md) | Application/operational logs |

## Configuration, build & ops

| Doc | Covers |
|-----|--------|
| [configuration.md](configuration.md) | `config/` (config.template.json → config.json) + `.env` |
| [containers.md](containers.md) | Dev / deploy compose + image strategy |
| [hook-setup.md](hook-setup.md) | Installing the hook on a machine |
| [compatibility.md](compatibility.md) | Claude Code version/hook compatibility (generated) |
| [branching.md](branching.md) · [dev-automation.md](dev-automation.md) · [development.md](development.md) · [testing.md](testing.md) · [tools.md](tools.md) | Branch model, dev scripts, local dev, testing, operational utilities |

## Design discussions

| Doc | Covers |
|-----|--------|
| [session-corpus-design-discussion.md](session-corpus-design-discussion.md) | Open design exploration of the session corpus |

## Decisions

[`decisions/`](decisions/) — Architecture Decision Records (ADRs 0001–0026). See
[decisions/README.md](decisions/README.md) for the index.

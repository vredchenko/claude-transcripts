# Contributor docs

For people changing Claude Transcripts. To install or run it, start at the
[documentation overview](../README.md).

These pages are read here, in the repository. The published site and an instance's
`/docs` carry only the sections written for people running the app (`start/`, `use/`,
`operate/`, `reference/`, and the architecture page); `scripts/build-docs.ts` holds
that list and still link-checks everything else.

## Working on the code

| To... | Read |
|-------|------|
| set up a checkout and run the parts | [Getting started](getting-started.md) |
| run or add tests | [Testing](testing.md) |
| regenerate what is generated, and know what CI runs | [Dev automation](dev-automation.md) |
| cut a release | [Releasing](releasing.md) |
| find your way around one package | [`shared`](../../packages/shared/README.md), [`webapi`](../../packages/webapi/README.md), [`webui`](../../packages/webui/README.md), [`cli`](../../packages/cli/README.md), [the plugin](../../hooks/README.md) |

## Design

| Page | Covers |
|------|--------|
| [Architecture](../design/architecture.md) | The parts, the data flow, the stores, the tiers. Start here. |
| [Roadmap](../design/roadmap.md) | What is not built yet, by tier. |
| [Decisions (ADRs)](../design/decisions/README.md) | One record per architectural decision, in the order they were taken. |
| [Database and search choices](../design/database-choice.md) | Why CouchDB and Meilisearch. |
| [Actions and bindings](../reference/actions.md) | What the hook does on each event, and how to add a behaviour. |
| [Mid-flight chunking](../design/mid-flight-chunking.md) | Recording the transcript while the session runs. |
| [Export and import bundles](../design/bundles.md) | How a bundle is built and restored. |
| [The Claude Code plugin](../design/plugin.md) | Visibility, skills and the recall policy. |
| [Application logging](../design/app-logging.md) | Planned, not built. |
| [Leaked secrets](../design/secrets.md) | Detection and scrubbing: future scope. |

## Where a new page goes

- **For someone running the app** (installing, using, operating, looking something
  up): `start/`, `use/`, `operate/` or `reference/`. It is published automatically.
  Write it for a reader who has never seen the source.
- **For someone changing the app**: `develop/` or `design/`, or the package's own
  `README.md` when it is about one package's code. Not published.
- **A page that is both** is two pages. Say what the thing does in the published one,
  how it is built in the other, and link them.

# Third-party icons

Marks for the software Claude Transcripts interoperates with or is built on, and a few
generic line icons, used in the stack diagram (`bun run diagram:stack`) and in the
webui's header menus. They are **not** our brand — for that, see
[`../README.md`](../README.md).

## Why they live here

Two consumers, and neither fetches anything:

- **The stack diagram.** `scripts/stack-diagram/icons.json` maps each icon name in the
  drawing to a file here ([ADR 0035](../../docs/design/decisions/0035-hand-drawn-stack-diagram.md)).
  Vendored rather than fetched at render time, so a redraw changes only when this repo
  does, and so every mark it shows has a provenance row below. The Lucide icons are
  tinted to the diagram's ink when it renders; the files stay as published.
- **The webui's header menus** (`packages/webui/src/components/nav/ServiceIcon.tsx`)
  import the backing services' marks, keyed by the blueprint's `IconKey`
  ([`topology.ts`](../../packages/shared/src/blueprint/topology.ts)), rather than
  keeping copies.

## Provenance

| File | Source |
|------|--------|
| `claude.svg` | [`@lobehub/icons`](https://github.com/lobehub/lobe-icons) — the **mono** variant. Mono, not colour, so the diagram can tint it per theme via `currentColor`. |
| `couchdb.svg` | Apache CouchDB mark. **One edit**: `viewBox="0 0 64 64"` added and `width`/`height` dropped — the original declared only pixel dimensions, so it would not scale. The declared 64×64 makes the viewBox exactly recoverable. |
| `garage.svg` | [Garage](https://garagehq.deuxfleurs.fr) (Deuxfleurs). **Adapted** — see the comment inside the file for exactly what was removed and why the viewBox changed. |
| `meilisearch.svg` | [Meilisearch](https://www.meilisearch.com) brand mark, Simple Icons house style. As published. |
| `github.svg`, `github-dark.svg` | GitHub Invertocat, from [svgl](https://svgl.app) (`github_light`, `github_dark`). As published. Fetched 2026-11-27. |
| `githubactions.svg` | GitHub Actions mark from [devicon](https://devicon.dev) at commit [`32fe1d3`](https://github.com/devicons/devicon/blob/32fe1d3b3f36ad11f90ab94f7db59738139c2bf6/icons/githubactions/githubactions-original.svg) (`githubactions-original`). As published. |
| `docker.svg` | Docker mark, from [svgl](https://svgl.app) (`docker`). As published. Fetched 2026-11-27. |
| `hono.svg` | [Hono](https://hono.dev) mark, from [svgl](https://svgl.app) (`hono`). As published. Fetched 2026-11-27. |
| `react.svg` | [React](https://react.dev) mark, from [svgl](https://svgl.app) (`react_light`). As published. Fetched 2026-11-27. |
| `lucide/*.svg` | [Lucide](https://lucide.dev) icons from `lucide-static@1.82.0`, ISC licence in [`lucide/LICENSE`](lucide/LICENSE). Generic line icons, not marks. As published. |
| `fossil.svg` | [Fossil SCM](https://fossil-scm.org) mark from [Simple Icons](https://simpleicons.org) (`fossilscm`, CC0). Fossil publishes its logo only as a GIF. **One edit**: Simple Icons' brand colour `#548294` set as `fill`, matching `meilisearch.svg`. |

**Policy:** upstream brand marks are used as the projects publish them. If one is
ever restyled upstream, refresh the file here rather than editing it in a consumer.
`garage.svg` is the single documented exception, and the file says so in its own
header.

## Trademarks

This repository is MIT-licensed. **These marks are not.** Each is the trademark of
its owner — Anthropic, the Apache Software Foundation, Deuxfleurs, Meili SAS, the
Fossil project, GitHub, Docker, the Hono project and Meta — reproduced here
nominatively, to identify the software this project talks to or is built on. The Lucide
icons are not marks; they are under the ISC licence in `lucide/LICENSE`. Their inclusion implies no affiliation with or endorsement by those
projects, and the repository's LICENSE does not extend to them. If you fork this
project and rebrand it, review these separately.

Incidentally, the clay `#D97757` in [`../README.md`](../README.md) is also
Anthropic's own brand colour, which is why the Claude mark sits naturally in our
palette.

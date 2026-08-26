# Third-party icons

Marks for the software Claude Transcripts interoperates with, used in the generated
architecture diagram (`bun run gen:diagram`). They are **not** our brand — for that,
see [`../README.md`](../README.md).

## Why they live here

Each file has exactly one declared consumer: a `TopologyNodeDef.icon` value in
[`packages/shared/src/model/topology.ts`](../../packages/shared/src/model/topology.ts).
The generator inlines them at build time — an SVG loaded through GitHub's image
proxy cannot fetch anything external, so a referenced icon would simply not appear.
`loadIcon` throws on a missing or malformed file, so a bad icon is a build failure
rather than a silently broken picture.

## Provenance

| File | Source |
|------|--------|
| `claude.svg` | [`@lobehub/icons`](https://github.com/lobehub/lobe-icons) — the **mono** variant. Mono, not colour, so the diagram can tint it per theme via `currentColor`. |
| `couchdb.svg` | Apache CouchDB mark. **One edit**: `viewBox="0 0 64 64"` added and `width`/`height` dropped — the original declared only pixel dimensions, so it would not scale. The declared 64×64 makes the viewBox exactly recoverable. |
| `garage.svg` | [Garage](https://garagehq.deuxfleurs.fr) (Deuxfleurs). **Adapted** — see the comment inside the file for exactly what was removed and why the viewBox changed. |
| `meilisearch.svg` | [Meilisearch](https://www.meilisearch.com) brand mark, Simple Icons house style. As published. |

Our own mark (`../logo-mark.svg`) stands in for the webapi and is referenced in
place, not copied.

**Policy:** upstream brand marks are used as the projects publish them. If one is
ever restyled upstream, refresh the file here rather than editing it in a consumer.
`garage.svg` is the single documented exception, and the file says so in its own
header.

## Trademarks

This repository is MIT-licensed. **These marks are not.** Each is the trademark of
its project — Anthropic, the Apache Software Foundation, Deuxfleurs, and Meili SAS
respectively — reproduced here nominatively, to identify the software this project
talks to. Their inclusion implies no affiliation with or endorsement by those
projects, and the repository's LICENSE does not extend to them. If you fork this
project and rebrand it, review these separately.

Incidentally, the clay `#D97757` in [`../README.md`](../README.md) is also
Anthropic's own brand colour, which is why the Claude mark sits naturally in our
palette.

# 35. The architecture picture is a hand-drawn stack diagram

Date: 2026-11-27

## Status

Accepted. Proposed in `rfcs/2026-11-21-hand-drawn-stack-diagram.md`. Replaces the
blueprint-generated diagram (`gen:diagram`).

## Context

The architecture picture used to be generated from the blueprint's topology
(`scripts/gen-diagram.ts` with `scripts/lib/{svg,icons}.ts`, about 875 lines). It was
introduced because the hand-typed diagrams before it drifted into being wrong: one showed
the hook writing to the stores directly. Generating it made it correct by construction,
but it drew the system as a flow of boxes and could not say **where things run**: what is
on the machine running Claude Code, what is on the server, and what GitHub builds and
publishes. That is the first question a new reader has.

The [stack-diagram](https://github.com/caru-ini/stack-diagram) agent skill draws that
picture well, with real marks and light and dark renders, from prose. The prose already
exists: the "Where things run" section of [architecture.md](../architecture.md#where-things-run).

## Decision

- **The drawn diagram replaces the generated one.** `docs/assets/architecture-stack.png`
  and `-dark.png` are the picture in the README, the landing page, architecture.md and
  getting-started.md. `gen-diagram.ts`, `lib/svg.ts`, `lib/icons.ts`, the three generated
  SVGs and `gen:diagram` (and its place in `gen:all`) are deleted.
- **The topology stays, and the drawing is tested against it.** `toArchitectureDiagram`
  and the topology tests remain. A test in `topology.test.ts` fails if the draft
  (`scripts/stack-diagram/architecture.html`) stops naming any compact-level node, as a
  box or in a box's caption. That catches a component left out or renamed. It does not
  catch a wrong arrow; that is what review of the PNGs is for.
- **Drawn in development, never in CI.** An agent edits the draft with the skill and runs
  `bun run diagram:stack`, which renders both PNGs and stamps the draft with a sha256 of
  architecture.md. `diagram:stack check` runs in lefthook (when architecture.md is
  staged) and CI, and only warns when the prose moved since the last stamp; a change that
  doesn't affect the picture is acknowledged with `diagram:stack stamp`. CLAUDE.md tells
  agents this.
- **Every icon is vendored.** `scripts/stack-diagram/icons.json` maps each icon name to a
  file in `brand/icons/`, with a provenance row in its README (Lucide pinned to
  `lucide-static@1.82.0`, devicon to a commit, svgl marks dated). Rendering fetches
  nothing and refuses an icon that isn't a repo file, so a redraw changes only when this
  repo does.
- **Dark theme everywhere.** The README and landing page use `<picture>` with the dark
  render. The docs build turns `![](x.png)` into a `<picture>` whenever `x-dark.png`
  exists beside it.
- **Weight is accepted, and trimmed.** About 230 and 250 KB per render, against 21 KB for
  the SVG. `diagram:stack` recompresses the PNGs losslessly (`scripts/lib/png.ts`,
  dependency-free) before writing them, since each redraw is committed.
- **The skill is vendored, and the lock is provenance only.**
  `.claude/skills/stack-diagram` is the upstream skill minus `share.py` and its "share to
  the gallery" step, which offered to upload diagrams to a third-party public site; nothing
  in this repo should offer that to a contributor's agent. Its contents therefore no
  longer match `skills-lock.json`'s `computedHash`. The lock records where it came from;
  don't restore the skill from it, which would bring `share.py` back.

## Consequences

- The picture can drift from the code again, within the limits of the coverage test and
  the warn-only check. Review the PNGs in any PR that touches architecture.md.
- Redrawing needs an agent with the skill, Python 3.9+ and a Playwright Chromium. A
  contributor without those who changes architecture.md can only `stamp` and say so.
- Adding an icon means vendoring it into `brand/icons/` with a provenance row.
- `brand/icons/` now serves the drawing and the webui's menus; the topology's `icon`
  keys remain for the webui.

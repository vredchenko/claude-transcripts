# A hand-drawn stack diagram beside (or instead of) the generated one

**Date:** 2026-11-21
**Status:** Accepted 2026-11-27 as
[ADR 0035](../docs/design/decisions/0035-hand-drawn-stack-diagram.md): instead of the
generated diagram, with every decision below taken as proposed (icons vendored rather
than pinned). The rest of this file is the proposal as it stood.

## What it is

A second architecture picture: the same system by **where things run** (your machine,
your server, GitHub), with real brand logos, drawn with the
[stack-diagram](https://github.com/caru-ini/stack-diagram) agent skill. It is drawn from
the "Where things run" section of
[architecture.md](../docs/design/architecture.md#where-things-run), not generated from
the blueprint like `gen:diagram`.

- **Skill:** vendored in `.claude/skills/stack-diagram`, pinned in `skills-lock.json`.
  The vendored copy drops the skill's `share.py` and its "share to the gallery" step,
  which offered to upload diagrams to a third-party public site. Nothing in this repo
  should offer that to a contributor's agent.
- **Draft:** `scripts/stack-diagram/architecture.html`, stamped with a sha256 of
  architecture.md. `scripts/stack-diagram/icons.json` maps icon tokens to `brand/icons/`
  marks or fetch specs.
- **Render:** `bun run diagram:stack` writes
  `build/stack-diagram/architecture-stack{.html,.png,-dark.png}` (gitignored).
  `diagram:stack stamp` records that the draft still matches the doc; `diagram:stack
  check` says whether the doc moved since. Rendering needs Python 3.9+, network access to
  the logo sources, and a Chromium (`CHROMIUM_PATH`, or `bun run test:browser:install`).

## Decisions before adopting it

What the generated diagram feeds today: the README (`<picture>`, light and dark SVG), the
landing page (`site/index.html`), and the top of architecture.md and getting-started.md.
Behind it: `scripts/gen-diagram.ts` and `scripts/lib/{svg,icons}.ts` (about 875 lines),
`toArchitectureDiagram` in the blueprint, and its tests in `topology.test.ts`.

1. **The guarantee it gives up.** The generated diagram exists because the hand-typed one
   drifted into being wrong (it showed the hook writing stores directly). A drawn one can
   drift again. Proposal: keep `toArchitectureDiagram` and the topology tests, and add a
   test that every service and client named in the blueprint appears in the draft. That
   catches a missing or renamed component, though not a wrong arrow.
2. **Beside or instead.** Beside keeps the guarantee and adds a picture that has to be
   kept in step by hand. Instead deletes `gen-diagram.ts` and `lib/svg.ts` /
   `lib/icons.ts` (no other users) and takes `gen:diagram` out of `gen:all`;
   `brand/icons/` stays.
3. **Dark theme on the docs and landing page.** The README handles a PNG pair with
   `<picture>`; the docs build escapes raw HTML and the landing page uses one SVG, so both
   would show the light PNG on a dark page. Proposal: in `build-docs.ts`, render
   `![](x.png)` as a `<picture>` when `x-dark.png` exists; the same in `site/index.html`.
4. **Weight.** About 300 KB per PNG and 135 KB for the self-contained HTML (fonts inlined),
   against a 21 KB SVG; every redraw adds them to git history again. Losslessly
   optimising the PNGs (`oxipng`) would help.
5. **Reproducibility and provenance.** `fetch_icons.py` pulls unpinned sources (Lucide with
   no version, devicon `master`, the svgl API), so a redraw can change with no edit here,
   and the GitHub, Docker, Hono, React and GitHub Actions marks it inlines have no
   provenance entry. Either pin the versions or vendor the SVGs into `brand/icons/` with
   rows in its README, as the diagram's existing marks have.
6. **Who can redraw.** Drawing needs an agent with the skill, plus Python, network and a
   Chromium. A contributor who edits architecture.md without those can only `stamp`. If it
   is adopted, a warn-only `diagram:stack check` in lefthook and CI says when the prose
   moved, and CLAUDE.md tells agents to redraw in development, never in CI.
7. **Vendored skill vs. restore from `skills-lock.json`.** The vendored copy is edited
   (above), so its contents no longer match the lock's `computedHash`; a restore would
   bring `share.py` back. Either keep it vendored and treat the lock as provenance only,
   or stop vendoring and accept the upstream skill as is.

## Adopting it

Write the outcome as an ADR, then: commit the renders where the docs build publishes them
(`docs/assets/`), embed them in architecture.md (and wherever decision 2 puts them), add
the CLAUDE.md rule and the warn-only check from decision 6, and document `diagram:stack`
in `docs/develop/dev-automation.md`.

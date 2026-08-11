# Browser suite (webui)

Playwright tests for the webui, plus the assessment tooling they're built from.

This is not the same thing as `tests/e2e/`. That suite proves the **write→read path**
works — hook writes, webapi reads, the numbers agree — and it needs a real stack. This
one proves the **UI renders correctly**, and deliberately needs nothing at all.

```
bun run test:browser:install     # one-time: download Chromium
bun run test:browser             # run the suite
bun run test:browser:capture     # screenshot + audit every route, write a report
```

## Two modes

**Mocked** (the default, and what CI runs). Playwright starts the Vite dev server and
answers every `/api/**` call from `fixtures/corpus.ts`. No CouchDB, no Garage, no
Meilisearch, no history on the machine — so it runs anywhere, and a failure is
unambiguously a front-end change.

**Live.** Point it at an instance's origin and the fixtures step aside:

```
E2E_BASE_URL=http://127.0.0.1:7650 bun run test:browser
E2E_BASE_URL=http://127.0.0.1:7650 bun run test:browser:capture
```

Assertions about specific fixture content skip themselves; the layout and console
audits still run. Pointing the audits at a real corpus is the fastest way to find which
of your own sessions breaks a layout — real transcripts contain shapes no fixture
anticipates.

## Browsers

Every spec runs on **Chromium and Firefox**, at a desktop and a phone width — four
projects: `chromium-desktop`, `chromium-mobile`, `firefox-desktop`, `firefox-mobile`.

Both engines earn their place. Nearly everything this app renders is flexbox and CSS
grid, and the bugs it grows are about intrinsic sizing — `min-width: auto` on flex
items, `max-content` measurement, grid track sizing — which is exactly where Gecko and
Blink still differ in the details. They already have: an overflowing row that Blink
placed over the pointer (so a click never landed) was click-through in Gecko, an
asymmetry a Chromium-only suite would have reported as a plain functional failure.

Both widths, because most of what this suite has caught only exists at the narrow one.

Run one project while iterating:

```
bunx playwright test --project=firefox-mobile
```

Firefox uses a plain narrow viewport rather than a device profile: Playwright's
`isMobile`/touch emulation is Chromium-only and a device descriptor throws rather than
degrading. Width is what these layouts respond to anyway.

## Layout

| Path | What it is |
| --- | --- |
| `fixtures/corpus.ts` | The synthetic dataset. Fixed timestamps, no randomness. |
| `helpers/mock-api.ts` | The fake webapi, served by request interception. |
| `helpers/app.ts` | Page objects + navigation. Specs address the app through these. |
| `helpers/audit.ts` | The reusable checks: overflow, page scroll, console output. |
| `helpers/known-broken.ts` | Declaring a check as currently-failing, self-clearingly. |
| `specs/*.browser.ts` | The tests. |
| `capture.ts` | Screenshot + audit every route; writes `.captures/report.md`. |

Specs are named `*.browser.ts`, not `*.spec.ts`, so `bun test` and `playwright test`
never collect each other's files.

## Fixtures are synthetic, and must stay that way

This is a public repo. The corpus contains no real paths, hostnames, or transcript
text — the same rule `scripts/regenerate-mock-fixtures.ts` applies to the hook
fixtures. Don't paste a real session in to reproduce a bug; work out which *shape* of
data broke it and add that shape.

The corpus is shaped to the cases that have actually broken this UI, not to a tidy
average: an unbroken 200-character line with nowhere to wrap, a session spanning four
days, a running session, one that never ended, one with neither transcript nor token
usage. When you fix a rendering bug, add the shape that caused it — that's what keeps
it fixed.

## What the audits check

`overflowingElements()` finds content that escapes the app's content container
sideways, ignoring anything inside a deliberately scrollable or clipping ancestor (a
wide table in a scrolling `TableContainer` is an affordance, not a bug). In this app the
finding has always meant the same thing: a flex child missing `min-width: 0`, so a
`nowrap` line forces its row to max-content width and the row spills out of its card.
It reports the outermost offender only.

`watchConsole()` collects console errors and warnings, deduplicated. Install it before
navigating — the messages worth catching are logged during the first render.

## Known-broken checks

`helpers/known-broken.ts` provides `knownBroken(reason)` for a check that finds a real
bug you aren't fixing in the same change: it runs, it fails, and the failure is
expected, so CI stays green without the finding being lost.

It is **self-clearing**. Fix the bug and the test passes, at which point Playwright
reports "expected to fail but passed" and the build goes red until the `knownBroken`
line is deleted — so removing it is part of the fix. Nothing currently uses it; the
eight it was introduced for have all been fixed.

## The clock is pinned

`setupPage` fixes the browser's clock to the corpus's anchor (`NOW`). The fixtures are
deterministic instants but the app measures against `Date.now()`, so without this a
*running* session — which by definition extends to now — stretches from the fixture's
March to whatever today happens to be, and the calendar draws it as a bar across five
months. Pinning also settles which day the calendar calls "today", and keeps
screenshots comparable over time.

## Geometry is not the only way a layout fails

The overflow audit catches content that escapes its box. It does not catch content that
*fits* and is useless: making the header fit a phone by letting the search field shrink
produced a 20-pixel input jammed against the settings button, with nothing overflowing
and nothing to report. Where a fix works by shrinking something, assert the thing stayed
big enough to use — see "the header search box stays usable at every width".

# Brand assets

Source-of-truth logo and icon files for **Claude Transcripts**. Copies are wired
into the webui (`packages/webui/public/favicon.svg`,
`packages/webui/src/assets/logo-mark.svg`) and the public site (`site/`); keep them
in sync with the masters here.

## Files

| File | Use |
|------|-----|
| `logo.svg` | Horizontal lockup (mark + wordmark). Wordmark auto-adapts to light/dark via `prefers-color-scheme`. Use in the README, the site header, docs. |
| `logo-mark.svg` | Icon-only mark. Use as the favicon, app-header glyph, and social/avatar icon. |

The mark is a stylised **transcript** — three conversation turns (a short user line,
a longer reply, a short user line) on a rounded card.

## Colours

| Token | Hex | Use |
|-------|-----|-----|
| Clay | `#D97757` | Primary brand colour (mark background, accents). The README badge uses the close variant `#CC785C`. |
| Ink | `#1F2328` | Wordmark on light backgrounds. |
| Paper | `#E6EDF3` | Wordmark on dark backgrounds. |

## Raster fallbacks

SVG covers modern browsers (the favicon is an SVG). If PNG/ICO fallbacks are needed
later (older browsers, `apple-touch-icon`, social cards), generate them from
`logo-mark.svg` — no rasters are committed yet to keep the tree lean.

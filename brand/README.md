# Brand assets

The **Claude Transcripts** mark: a live pulse on top (the session as it streams), a
prompt and settled lines below (the archive), a cursor block at the end. Drawn on a
24-unit grid as filled outlines with a transparent background.

## Source vs generated

Only `source/` is edited by hand. Everything else in this directory, and the copies the
webui and site serve, is derived from it by **`bun run gen:brand`**
(`scripts/gen-brand.ts`, part of `gen:all`; CI fails if the output is stale).

| Source | What it is |
|--------|------------|
| `source/mark.svg` | The mark, regular weight. Exactly two paths: `#base` and `#accent`. |
| `source/mark-favicon.svg` | The same mark with heavier strokes, used at 48px and below. |
| `source/palette.json` | Ink, accent and paper colours for light and dark. |

To redraw the mark, edit the two paths in both masters (absolute `M`/`Z` polygons only,
so the font builder can read them) and run `bun run gen:brand`.

## Generated

| Path | Use |
|------|-----|
| `mark/mark-colour.svg` | Base is `currentColor`, accent is `var(--icon-accent, #c8371e)`. For inlining in a page that styles it. |
| `mark/mark-mono.svg` | One colour, `currentColor`. For masks, single-ink print, tinting. |
| `mark/mark-adaptive.svg` | Follows `prefers-color-scheme` by itself. For `<img>` on a page that does too. |
| `mark/mark-light.svg`, `mark/mark-dark.svg` | Fixed colours for a known background (and for tools that ignore CSS). |
| `mark/mark-favicon-*.svg` | The same five variants of the heavier cut. |
| `logo.svg`, `logo-light.svg`, `logo-dark.svg` | Horizontal lockup, mark + wordmark. `logo.svg` adapts. README, site, docs. |
| `png/mark-{light,dark}-{16…512}.png` | Transparent rasters. `light` = for light backgrounds. |
| `png/icon-{192,512}.png`, `icon-512-dark.png` | Rounded opaque tiles: PWA icons, avatars. |
| `png/icon-maskable-512.png` | Full-bleed, mark inside the maskable safe zone. |
| `png/apple-touch-icon.png` | 180px full-bleed; iOS rounds it. |
| `favicon.ico` | 16/32/48, for clients that ignore SVG favicons. |
| `font/claude-transcripts-glyph.ttf` | The mark as a font glyph — see below. |

Copied for serving as-is: `packages/webui/public/` (favicons, PWA icons,
`manifest.webmanifest`) and `site/` (favicons, `mark.svg`). The webui header imports
`mark/mark-dark.svg` directly; the docs build inlines `mark/mark-colour.svg`.

## Colours

| Token | Light | Dark | Use |
|-------|-------|------|-----|
| Ink | `#1a1817` | `#ece7df` | The prompt and lines; wordmark. |
| Accent | `#c8371e` | `#ff6b4a` | Pulse and cursor. |
| Paper | `#f4f1ec` | `#16130f` | Opaque tile backgrounds. |

## Terminal glyph

`font/claude-transcripts-glyph.ttf` carries the mark at **U+E010** (regular) and
**U+E011** (favicon weight), in the Private Use Area and outside every Nerd Fonts v3
range, so it never shadows an existing icon. A font glyph is one colour; the terminal
tints it.

Install it like any font (`~/.local/share/fonts` on Linux, Font Book on macOS) and most
terminals fall back to it for those codepoints automatically. Where they don't:

    # kitty.conf
    symbol_map U+E010-U+E011 Claude Transcripts Glyph

    # WezTerm: add it to the font fallback list
    font = wezterm.font_with_fallback { "Your Font", "Claude Transcripts Glyph" }

    # or patch it into a Nerd Font
    fontforge -script font-patcher --complete --custom claude-transcripts-glyph.ttf YourFont.ttf

Then `claude-transcripts statusline install --glyph` puts it at the head of the
Claude Code statusline.

## Third-party marks

`icons/` holds **other projects'** marks (CouchDB, Garage, Meilisearch, Claude, Fossil)
used in the architecture diagram. Not our brand, and not covered by this repo's LICENSE
— see [`icons/README.md`](icons/README.md).

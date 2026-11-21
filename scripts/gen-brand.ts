#!/usr/bin/env bun
/**
 * Derive every brand asset from the two geometry masters and the palette.
 *
 *   bun run scripts/gen-brand.ts   (or: bun run gen:brand)
 *
 * Inputs (hand-edited, the only brand files that are):
 *   brand/source/mark.svg          the mark, regular weight (24-unit grid)
 *   brand/source/mark-favicon.svg  the same mark, heavier strokes for 48px and below
 *   brand/source/palette.json      ink / accent / paper, light and dark
 *
 * Each master holds exactly two paths, `#base` and `#accent`. Every variant is the
 * same geometry painted differently, so a redraw is one edit to a master and one run
 * of this script; nothing downstream is drawn by hand.
 *
 * Outputs (all committed; CI re-runs `gen:all` and fails on a diff):
 *   brand/mark/        SVG variants: colour, mono, adaptive, light, dark (× 2 weights)
 *   brand/logo*.svg    horizontal lockup, adaptive + fixed light/dark
 *   brand/png/         transparent PNGs 16–512, and opaque tiles (PWA, iOS)
 *   brand/favicon.ico  16/32/48 for clients that ignore SVG favicons
 *   brand/font/        a one-glyph TTF (U+E010, U+E011) for terminals — the statusline
 *   + the copies the webui (`packages/webui/public/`) and site (`site/`) serve as-is.
 *
 * Rasters come from resvg, not a browser: it is deterministic for a given version,
 * which a diff-checked generated file has to be. Dev-only tooling.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { Resvg } from "@resvg/resvg-js";
import svg2ttf from "svg2ttf";

const ROOT = join(import.meta.dir, "..");
const BRAND = join(ROOT, "brand");
const NAME = "Claude Transcripts";

interface Tone {
  ink: string;
  accent: string;
  paper: string;
}
const palette = JSON.parse(readFileSync(join(BRAND, "source", "palette.json"), "utf8")) as {
  light: Tone;
  dark: Tone;
};

interface Geometry {
  base: string;
  accent: string;
}

function loadGeometry(file: string): Geometry {
  const raw = readFileSync(join(BRAND, "source", file), "utf8");
  const d = (id: string) => {
    const m = raw.match(new RegExp(`<path[^>]*\\sid="${id}"[^>]*\\sd="([^"]+)"`));
    if (!m?.[1]) throw new Error(`brand/source/${file}: no <path id="${id}" d="…">`);
    if (/[^MZ\d.\s-]/.test(m[1])) {
      // The font builder below only understands absolute polygons.
      throw new Error(`brand/source/${file}: #${id} uses commands other than M/Z`);
    }
    return m[1];
  };
  if (!/viewBox="0 0 24 24"/.test(raw))
    throw new Error(`brand/source/${file}: expected a 24×24 viewBox`);
  return { base: d("base"), accent: d("accent") };
}

const WEIGHTS = {
  mark: loadGeometry("mark.svg"),
  "mark-favicon": loadGeometry("mark-favicon.svg"),
};
type Weight = keyof typeof WEIGHTS;

// ── SVG variants ─────────────────────────────────────────────────────────────

const OPEN = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" role="img" aria-label="${NAME}">`;
type Variant = "colour" | "mono" | "adaptive" | "light" | "dark";

/** The two paths, painted. Shared by the standalone variants and the composites. */
function paths(g: Geometry, base: string, accent: string): string {
  return `<path fill="${base}" d="${g.base}"/><path fill="${accent}" d="${g.accent}"/>`;
}

const ADAPTIVE_STYLE =
  `<style>.b{fill:${palette.light.ink}}.a{fill:${palette.light.accent}}` +
  `@media (prefers-color-scheme:dark){.b{fill:${palette.dark.ink}}.a{fill:${palette.dark.accent}}}</style>`;

function variant(g: Geometry, v: Variant): string {
  switch (v) {
    case "colour":
      // Base follows the surrounding text; the accent is a CSS hook with a fallback.
      return `${OPEN}${paths(g, "currentColor", `var(--icon-accent, ${palette.light.accent})`)}</svg>\n`;
    case "mono":
      return `${OPEN.replace(">", ' fill="currentColor">')}<path d="${g.base}${g.accent}"/></svg>\n`;
    case "adaptive":
      return `${OPEN}${ADAPTIVE_STYLE}<path class="b" d="${g.base}"/><path class="a" d="${g.accent}"/></svg>\n`;
    case "light":
    case "dark":
      return `${OPEN}${paths(g, palette[v].ink, palette[v].accent)}</svg>\n`;
  }
}

// ── Lockup ───────────────────────────────────────────────────────────────────

function lockup(tone: "adaptive" | "light" | "dark"): string {
  const g = WEIGHTS.mark;
  const t = tone === "adaptive" ? palette.light : palette[tone];
  const style =
    tone === "adaptive"
      ? `<style>.b,.wm{fill:${palette.light.ink}}.a{fill:${palette.light.accent}}` +
        `@media (prefers-color-scheme:dark){.b,.wm{fill:${palette.dark.ink}}.a{fill:${palette.dark.accent}}}</style>`
      : "";
  const paint = (cls: string, fill: string) =>
    tone === "adaptive" ? `class="${cls}"` : `fill="${fill}"`;
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 240 40" role="img" aria-label="${NAME}">`,
    style,
    `<g transform="translate(4 4) scale(${32 / 24})">`,
    `<path ${paint("b", t.ink)} d="${g.base}"/><path ${paint("a", t.accent)} d="${g.accent}"/></g>`,
    `<text ${paint("wm", t.ink)} x="48" y="26" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif" font-size="19" font-weight="700" letter-spacing="-0.2">${NAME}</text>`,
    "</svg>\n",
  ].join("");
}

// ── Rasters ──────────────────────────────────────────────────────────────────

function png(svg: string, size: number): Buffer {
  return new Resvg(svg, { fitTo: { mode: "width", value: size } }).render().asPng();
}

/** The heavier cut reads better at favicon sizes. */
const weightFor = (size: number): Weight => (size <= 48 ? "mark-favicon" : "mark");

function transparent(tone: "light" | "dark", size: number): Buffer {
  return png(variant(WEIGHTS[weightFor(size)], tone), size);
}

/**
 * The mark on an opaque paper tile. `rounded` for surfaces that show the PNG as-is
 * (a PWA icon with `purpose: any`); full-bleed for those that mask it themselves (iOS
 * rounds apple-touch-icon; a maskable icon is cropped to any shape inside the inner
 * 80%, so the mark keeps to the middle `1 - 2 × pad`).
 */
function tile(tone: "light" | "dark", size: number, opts: { rounded: boolean; pad: number }) {
  const t = palette[tone];
  const g = WEIGHTS[weightFor(size)];
  const inner = 24 * (1 - 2 * opts.pad);
  const k = inner / 24;
  const off = 24 * opts.pad;
  const rx = opts.rounded ? 24 * 0.22 : 0;
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">` +
    `<rect width="24" height="24" rx="${rx}" fill="${t.paper}"/>` +
    `<g transform="translate(${off} ${off}) scale(${k})">${paths(g, t.ink, t.accent)}</g></svg>`;
  return png(svg, size);
}

/** An ICO is a directory of PNGs; every client that still wants one reads PNG entries. */
function ico(images: { size: number; data: Buffer }[]): Buffer {
  const header = Buffer.alloc(6 + 16 * images.length);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2); // icon
  header.writeUInt16LE(images.length, 4);
  let offset = header.length;
  images.forEach(({ size, data }, i) => {
    const e = 6 + 16 * i;
    header.writeUInt8(size >= 256 ? 0 : size, e);
    header.writeUInt8(size >= 256 ? 0 : size, e + 1);
    header.writeUInt16LE(1, e + 4); // planes
    header.writeUInt16LE(32, e + 6); // bpp
    header.writeUInt32LE(data.length, e + 8);
    header.writeUInt32LE(offset, e + 12);
    offset += data.length;
  });
  return Buffer.concat([header, ...images.map((i) => i.data)]);
}

// ── Glyph font ───────────────────────────────────────────────────────────────

/**
 * U+E010 is the regular mark, U+E011 the favicon weight. Private Use Area, outside
 * every Nerd Fonts v3 range, so it never shadows an icon a patched font already has.
 * A font is one colour: both paths become one glyph, tinted by the terminal.
 */
export const GLYPH_CODEPOINTS = { mark: 0xe010, "mark-favicon": 0xe011 } as const;
const EM = 1000;
const ASCENT = 800;

/** 24-unit, y-down SVG polygons → font units, y-up. */
function toFontPath(d: string): string {
  const s = EM / 24;
  const out: string[] = [];
  const tokens = d.match(/[MZ]|-?\d*\.?\d+/g) ?? [];
  let nums: number[] = [];
  const flush = () => {
    for (let i = 0; i + 1 < nums.length; i += 2) {
      const x = Math.round((nums[i] as number) * s);
      const y = Math.round(ASCENT - (nums[i + 1] as number) * s);
      out.push(`${out.length && out[out.length - 1] !== "Z" ? "L" : "M"}${x} ${y}`);
    }
    nums = [];
  };
  for (const tok of tokens) {
    if (tok === "M") {
      flush();
      if (out.length && out[out.length - 1] !== "Z") out.push("Z");
    } else if (tok === "Z") {
      flush();
      out.push("Z");
    } else nums.push(Number(tok));
  }
  flush();
  return out.join(" ");
}

function glyphFont(): Buffer {
  const glyphs = (Object.keys(GLYPH_CODEPOINTS) as Weight[])
    .map((w) => {
      const g = WEIGHTS[w];
      const cp = GLYPH_CODEPOINTS[w];
      return `<glyph glyph-name="${w}" unicode="&#x${cp.toString(16)};" horiz-adv-x="${EM}" d="${toFontPath(g.base)} ${toFontPath(g.accent)}"/>`;
    })
    .join("");
  const svgFont =
    `<svg xmlns="http://www.w3.org/2000/svg"><defs><font id="ClaudeTranscriptsGlyph" horiz-adv-x="${EM}">` +
    `<font-face font-family="Claude Transcripts Glyph" units-per-em="${EM}" ascent="${ASCENT}" descent="${ASCENT - EM}"/>` +
    `<missing-glyph horiz-adv-x="${EM}"/>${glyphs}</font></defs></svg>`;
  // A fixed timestamp keeps the file byte-stable between runs.
  const ttf = svg2ttf(svgFont, { ts: 0, version: "1.0", description: `${NAME} mark` });
  return Buffer.from(ttf.buffer);
}

// ── Write ────────────────────────────────────────────────────────────────────

const written: string[] = [];
function out(rel: string, data: string | Buffer) {
  const p = join(ROOT, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, data);
  written.push(relative(ROOT, p));
}

for (const w of Object.keys(WEIGHTS) as Weight[]) {
  for (const v of ["colour", "mono", "adaptive", "light", "dark"] as const) {
    out(`brand/mark/${w}-${v}.svg`, variant(WEIGHTS[w], v));
  }
}
out("brand/logo.svg", lockup("adaptive"));
out("brand/logo-light.svg", lockup("light"));
out("brand/logo-dark.svg", lockup("dark"));

for (const tone of ["light", "dark"] as const) {
  for (const size of [16, 32, 48, 64, 128, 256, 512]) {
    out(`brand/png/mark-${tone}-${size}.png`, transparent(tone, size));
  }
}
const tiles = {
  "icon-192.png": tile("light", 192, { rounded: true, pad: 0.16 }),
  "icon-512.png": tile("light", 512, { rounded: true, pad: 0.16 }),
  "icon-512-dark.png": tile("dark", 512, { rounded: true, pad: 0.16 }),
  "icon-maskable-512.png": tile("light", 512, { rounded: false, pad: 0.24 }),
  "apple-touch-icon.png": tile("light", 180, { rounded: false, pad: 0.18 }),
};
for (const [name, data] of Object.entries(tiles)) out(`brand/png/${name}`, data);

const favicon = ico([16, 32, 48].map((size) => ({ size, data: transparent("light", size) })));
out("brand/favicon.ico", favicon);
out("brand/font/claude-transcripts-glyph.ttf", glyphFont());

// Served verbatim, so they are copies rather than references. The SVG favicon is the
// adaptive one: a browser tab follows the OS scheme, not the page's.
const faviconSvg = variant(WEIGHTS["mark-favicon"], "adaptive");
for (const dir of ["packages/webui/public", "site"]) {
  out(`${dir}/favicon.svg`, faviconSvg);
  out(`${dir}/favicon.ico`, favicon);
  out(`${dir}/apple-touch-icon.png`, tiles["apple-touch-icon.png"]);
}
out("site/mark.svg", variant(WEIGHTS.mark, "adaptive"));
out(
  "packages/webui/public/manifest.webmanifest",
  `${JSON.stringify(
    {
      name: NAME,
      short_name: "Transcripts",
      start_url: ".",
      display: "standalone",
      // The webui's own surface (theme.ts), so the splash matches the app it opens.
      background_color: "#1d2021",
      theme_color: "#1d2021",
      icons: [
        { src: "icon-192.png", sizes: "192x192", type: "image/png" },
        { src: "icon-512.png", sizes: "512x512", type: "image/png" },
        { src: "icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
      ],
    },
    null,
    2,
  )}\n`,
);
for (const name of ["icon-192.png", "icon-512.png", "icon-maskable-512.png"] as const) {
  out(`packages/webui/public/${name}`, tiles[name]);
}

console.log(`[gen-brand] wrote ${written.length} files from brand/source/`);

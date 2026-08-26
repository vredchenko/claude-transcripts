/**
 * Read a vendored mark from `brand/icons/` and place it inside the diagram.
 *
 * Inlining is not a style choice: an SVG served through GitHub's image proxy runs in
 * secure static mode and cannot fetch anything external, so a referenced icon simply
 * would not appear. That makes the icon files build inputs, and `loadIcon` asserts on
 * them rather than trusting them — a malformed mark should fail the generator, not
 * ship a broken README image.
 */
import { readFileSync } from "node:fs";
import { type Box, el, escapeXml } from "./svg";

export interface Icon {
  viewBox: string;
  body: string;
  /** Inheritable paint that was set on the root element — see `rootPaintAttrs`. */
  rootPaint: Record<string, string>;
  /** The mark's own name, from its `<title>` or root `aria-label`. */
  title: string;
}

/**
 * Rewrite every internal id so two inlined marks can't collide.
 *
 * Today's four icons have no ids at all, so this is doing nothing yet — which is
 * exactly why it has to exist now. Bare `id="a"` is what an optimiser emits, the
 * collision is silent (the second gradient simply wins), and the day someone drops in
 * a fifth icon is not the day to discover that.
 */
function namespaceIds(fragment: string, prefix: string): string {
  const ids = new Set<string>();
  for (const m of fragment.matchAll(/\sid="([^"]+)"/g)) ids.add(m[1] as string);
  let out = fragment;
  for (const id of ids) {
    const esc = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    out = out
      .replace(new RegExp(`\\sid="${esc}"`, "g"), ` id="${prefix}${id}"`)
      .replace(new RegExp(`url\\(#${esc}\\)`, "g"), `url(#${prefix}${id})`)
      .replace(new RegExp(`(xlink:)?href="#${esc}"`, "g"), `$1href="#${prefix}${id}"`);
  }
  return out;
}

/** Strip what an inlined fragment must not carry into the host document. */
function sanitise(body: string): string {
  return body
    .replace(/<\?xml[\s\S]*?\?>/g, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<metadata[\s\S]*?<\/metadata>/g, "")
    .replace(/<style[\s\S]*?<\/style>/g, "")
    .replace(/<title[\s\S]*?<\/title>/g, "")
    .replace(/<desc[\s\S]*?<\/desc>/g, "")
    .replace(/\sclass="[^"]*"/g, "")
    .trim();
}

/** Read and validate one mark. Takes a full path — the caller owns the key→file map. */
export function loadIcon(path: string): Icon {
  const raw = readFileSync(path, "utf8");
  const open = raw.match(/<svg\b[^>]*>/);
  if (!open) throw new Error(`${path}: no <svg> root element`);
  const viewBox = open[0].match(/viewBox="([^"]+)"/)?.[1];
  if (!viewBox) {
    throw new Error(`${path}: no viewBox — the mark cannot be scaled into a slot`);
  }
  const inner = raw.slice((open.index ?? 0) + open[0].length, raw.lastIndexOf("</svg>"));
  const body = sanitise(inner);
  for (const bad of ["<script", "<image", "<foreignObject", 'href="http']) {
    if (body.includes(bad)) throw new Error(`${path}: contains ${bad} — not self-contained`);
  }
  if (!body) throw new Error(`${path}: empty after sanitising`);
  // Read the name before `sanitise` strips the source <title>.
  const title = inner.match(/<title[^>]*>([\s\S]*?)<\/title>/)?.[1]?.trim();
  const ariaLabel = open[0].match(/aria-label="([^"]*)"/)?.[1];
  if (!title && !ariaLabel) throw new Error(`${path}: no <title> or aria-label — unnamed mark`);
  return {
    viewBox,
    body,
    rootPaint: rootPaintAttrs(open[0]),
    title: (title || ariaLabel) as string,
  };
}

/**
 * Inheritable paint set on the root element, which discarding the root tag would
 * otherwise throw away.
 *
 * Not a nicety: Meilisearch's mark carries its entire brand colour as `fill` on the
 * root and its paths carry none, so dropping this renders it black; the Claude mono
 * mark carries `fill="currentColor"` the same way. Both failed silently — the icon
 * still appeared, just in the wrong colour.
 *
 * Allowlisted rather than copied wholesale, because the root also carries layout junk
 * that must not survive (`width`/`height`/`viewBox`, and lobehub's `style="flex:none"`).
 */
const ROOT_PAINT = [
  "fill",
  "fill-rule",
  "fill-opacity",
  "stroke",
  "stroke-width",
  "stroke-linecap",
  "stroke-linejoin",
  "stroke-opacity",
  "opacity",
  "color",
] as const;

function rootPaintAttrs(openTag: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of ROOT_PAINT) {
    const m = openTag.match(new RegExp(`\\s${name}="([^"]*)"`));
    if (m?.[1]) out[name] = m[1];
  }
  return out;
}

/**
 * Place an icon in a slot as a nested `<svg>` rather than `<symbol>`/`<use>`: it
 * isolates the mark's coordinate system completely, and `preserveAspectRatio`
 * letterboxes a non-square mark (the Garage one is 1.45:1) inside a square slot with
 * no arithmetic on our side.
 *
 * `color` drives marks drawn with `currentColor` — that is the whole reason the
 * Claude icon is vendored in its mono variant.
 */
export function placeIcon(icon: Icon, slot: Box, idPrefix: string, color?: string): string {
  const inner = el(
    "svg",
    {
      x: slot.x,
      y: slot.y,
      width: slot.w,
      height: slot.h,
      viewBox: icon.viewBox,
      preserveAspectRatio: "xMidYMid meet",
      overflow: "visible",
      // Decorative: every icon sits beside the node's own text label, and the root
      // <svg> carries the full <desc>, so `aria-hidden` stops the mark being
      // announced twice. The <title> is kept anyway — it names the mark for anything
      // inspecting the file, and it is what Biome's a11y rule looks for.
      "aria-hidden": "true",
      role: "presentation",
      ...icon.rootPaint,
    },
    [el("title", {}, [escapeXml(icon.title)]), namespaceIds(icon.body, idPrefix)],
  );
  // `style="color:…"`, not a `color=` presentation attribute: `var()` substitution is
  // reliable in a CSS declaration and is not in a presentation attribute, and the
  // silent failure mode there is a mark drawn in its fallback colour — which on the
  // dark diagram means a near-black glyph on a near-black card.
  return color ? `<g style="color:${escapeXml(color)}">${inner}</g>` : inner;
}

/**
 * A minimal SVG emitter: boxes, text, elbows, arrowheads.
 *
 * Dependency-free on purpose, like `build-docs.ts` — the diagram is generated in CI
 * on a `--frozen-lockfile` install, and a layout engine would fight us anyway: the
 * scene is a handful of boxes whose arrangement is already stated by the model's
 * `rank`. What is *not* optional is determinism. CI regenerates every committed
 * artifact and fails on `git diff --exit-code`, so every helper here is written to
 * emit the same bytes for the same input: attributes come out in object-literal
 * order, and coordinates go through `n()`.
 */

/** Round for output: 2 dp, `-0` normalised, trailing zeros dropped. */
export function n(v: number): string {
  const r = Math.round(v * 100) / 100;
  return String(Object.is(r, -0) ? 0 : r);
}

export function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export type Attrs = Record<string, string | number | undefined>;

/** An element. `undefined` attribute values are omitted, so callers can branch inline. */
export function el(tag: string, attrs: Attrs, children?: string[]): string {
  const a = Object.entries(attrs)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => ` ${k}="${typeof v === "number" ? n(v) : escapeXml(String(v))}"`)
    .join("");
  return children?.length ? `<${tag}${a}>${children.join("")}</${tag}>` : `<${tag}${a}/>`;
}

export function group(attrs: Attrs, children: string[]): string {
  return el("g", attrs, children.length ? children : [""]);
}

export interface Point {
  x: number;
  y: number;
}
export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export const cx = (b: Box): number => b.x + b.w / 2;
export const cy = (b: Box): number => b.y + b.h / 2;

export function rect(b: Box, attrs: Attrs = {}): string {
  return el("rect", { x: b.x, y: b.y, width: b.w, height: b.h, ...attrs });
}

export function text(x: number, y: number, s: string, attrs: Attrs = {}): string {
  return el("text", { x, y, ...attrs }, [escapeXml(s)]);
}

// ── Text measurement ─────────────────────────────────────────────────────────
//
// No measuring engine here, so widths are estimated from character classes. The
// estimate is used *only* to size a box around its text, and text is always drawn
// `text-anchor="middle"` at the box centre — so an error shows up as slightly tight
// or loose padding, symmetric on both sides, never as clipped or overflowing text.
// Helvetica / Arial / Segoe UI / Roboto agree within a few percent on these classes,
// which is all the accuracy that failure mode needs.
//
// `textLength`/`lengthAdjust` would make widths exact, at the cost of distorting the
// glyphs on every machine whose font *did* match. Not worth it.

const NARROW = new Set("iljItf.,:;'\"|!()[]/\\-");
const WIDE = new Set("mMWw@");

export function measureText(s: string, fontSize: number, bold = false): number {
  let units = 0;
  for (const ch of s) {
    if (ch === " ") units += 0.28;
    else if (NARROW.has(ch)) units += 0.3;
    else if (WIDE.has(ch)) units += 0.86;
    else if (ch >= "0" && ch <= "9") units += 0.56;
    else if (ch >= "A" && ch <= "Z") units += 0.68;
    else units += 0.53;
  }
  return units * fontSize * (bold ? 1.04 : 1);
}

/** The font stack, single-quoted so it needs no XML entity escaping. */
export const FONT_STACK =
  "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";

// ── Anchors ──────────────────────────────────────────────────────────────────

/**
 * A point on one face, spread evenly when several edges share it — otherwise the
 * three client arrows converging on the gateway all land on the same pixel.
 * `i` is 0-based among `of` edges on that face.
 */
export function anchorOnFace(b: Box, face: "l" | "r" | "t" | "b", i: number, of: number): Point {
  const t = (i + 1) / (of + 1);
  switch (face) {
    case "l":
      return { x: b.x, y: b.y + b.h * t };
    case "r":
      return { x: b.x + b.w, y: b.y + b.h * t };
    case "t":
      return { x: b.x + b.w * t, y: b.y };
    default:
      return { x: b.x + b.w * t, y: b.y + b.h };
  }
}

/** Where the centre-to-`towards` ray leaves the box — for diagonal edges. */
export function anchorOnRect(b: Box, towards: Point): Point {
  const dx = towards.x - cx(b);
  const dy = towards.y - cy(b);
  if (dx === 0 && dy === 0) return { x: cx(b), y: cy(b) };
  const sx = dx === 0 ? Number.POSITIVE_INFINITY : b.w / 2 / Math.abs(dx);
  const sy = dy === 0 ? Number.POSITIVE_INFINITY : b.h / 2 / Math.abs(dy);
  const s = Math.min(sx, sy);
  return { x: cx(b) + dx * s, y: cy(b) + dy * s };
}

/** Pull `b` back towards `a` by `by` units, so an arrowhead's tip lands on the border. */
export function shorten(a: Point, b: Point, by: number): Point {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy);
  if (len <= by || len === 0) return b;
  return { x: b.x - (dx / len) * by, y: b.y - (dy / len) * by };
}

// ── Paths ────────────────────────────────────────────────────────────────────

/**
 * A left-to-right elbow: out horizontally, across vertically, then in. Corners are
 * rounded with quadratic curves — reads calmer than mitred corners, and degrades to a
 * straight line when the two points already share a y.
 *
 * `transit` is where along the run the vertical crossing happens, 0..1. It exists so
 * the crossing can be moved out from under the edge's label: a bundle labelled at the
 * source end transits late, one labelled at the target end transits early, and either
 * way the label lands on a horizontal run rather than across the vertical one.
 */
export function orthPath(a: Point, b: Point, transit = 0.5, radius = 8): string {
  if (Math.abs(a.y - b.y) < 0.5) return `M${n(a.x)} ${n(a.y)}H${n(b.x)}`;
  const mid = a.x + (b.x - a.x) * transit;
  const r = Math.min(radius, Math.abs(b.y - a.y) / 2, Math.abs(mid - a.x), Math.abs(b.x - mid));
  const down = b.y > a.y ? 1 : -1;
  const fwd = b.x > a.x ? 1 : -1;
  return [
    `M${n(a.x)} ${n(a.y)}`,
    `H${n(mid - r * fwd)}`,
    `Q${n(mid)} ${n(a.y)} ${n(mid)} ${n(a.y + r * down)}`,
    `V${n(b.y - r * down)}`,
    `Q${n(mid)} ${n(b.y)} ${n(mid + r * fwd)} ${n(b.y)}`,
    `H${n(b.x)}`,
  ].join("");
}

export function line(a: Point, b: Point): string {
  return `M${n(a.x)} ${n(a.y)}L${n(b.x)} ${n(b.y)}`;
}

/**
 * An arrowhead marker. `markerUnits="userSpaceOnUse"` deliberately: with the default
 * `strokeWidth` the head rescales whenever a line's stroke width changes, and the
 * geometry drifts without anyone editing the marker.
 */
export function marker(id: string, fill: string, len = 7): string {
  return el(
    "marker",
    {
      id,
      markerUnits: "userSpaceOnUse",
      markerWidth: len,
      markerHeight: len,
      refX: len,
      refY: len / 2,
      orient: "auto",
    },
    [el("path", { d: `M0 0L${n(len)} ${n(len / 2)}L0 ${n(len)}z`, fill })],
  );
}

export const MARKER_LEN = 7;

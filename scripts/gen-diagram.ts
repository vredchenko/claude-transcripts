#!/usr/bin/env bun
import { join } from "node:path";
import {
  type ArchitectureDiagram,
  buildAppModel,
  type DiagramEdge,
  type DiagramNode,
  toArchitectureDiagram,
} from "@claude-transcripts/shared";
import { loadConfigTemplate } from "./lib/config-file";
import { type Icon, loadIcon, placeIcon } from "./lib/icons";
import {
  type Attrs,
  anchorOnFace,
  anchorOnRect,
  type Box,
  cx,
  cy,
  el,
  escapeXml,
  FONT_STACK,
  group,
  line,
  MARKER_LEN,
  marker,
  measureText,
  orthPath,
  type Point,
  rect,
  shorten,
  text,
} from "./lib/svg";

/**
 * Render the architecture diagram from the app model.
 *
 *   bun run scripts/gen-diagram.ts   (or: bun run gen:diagram)
 *
 * Replaces the hand-typed ASCII that used to open the README. That drawing existed in
 * five places, had already drifted (`cli` vs `CLI`), and — more seriously — all five
 * copies were wrong: they routed the hook *through* the webapi, when ADR 0016's
 * amendment is precisely that the hook writes to CouchDB and S3 **directly**, so that
 * recording a session never depends on the webapi being up. Generating the picture is
 * what makes that claim checkable.
 *
 * Three files come out of one scene. The split is forced, not stylistic:
 *   - the README is rendered by GitHub, which serves SVGs through an image proxy in
 *     secure static mode, where an embedded <style> is unreliable — so it gets a
 *     light/dark pair behind <picture>, GitHub's own documented mechanism;
 *   - a docs page cannot use <picture>, because build-docs.ts escapes raw HTML — so
 *     it gets one theme-aware file switching on `prefers-color-scheme`, the technique
 *     brand/logo.svg already uses.
 * They land under docs/ because that is the only location the Pages build can reach:
 * a link escaping docs/ gets rewritten to a GitHub *blob HTML* URL and renders broken.
 *
 * DETERMINISM. CI runs `gen:all` then `git diff --exit-code`, so the bytes must be a
 * pure function of committed files:
 *   - the config comes from `loadConfigTemplate` (never the gitignored config.json)
 *     and the env passed to `buildAppModel` is empty — otherwise a contributor's
 *     `WEBAPI_PORT` or a local `features` toggle silently changes the output and
 *     fails the gate on their PR for reasons CI cannot reproduce;
 *   - no version string is emitted (with no env, `identity.version` is the
 *     "0.0.0-dev" fallback, which would be both wrong and churning);
 *   - no Date, no Math.random;
 *   - coordinates are rounded at emit time by `n()`; attributes come out in
 *     object-literal order; iteration is over arrays, never over mutated maps.
 *
 * Dev-only tooling; the output is committed like the other generated files.
 */

const ROOT = join(import.meta.dir, "..");

// ── Palette ──────────────────────────────────────────────────────────────────
// GitHub Primer + our clay, matching SHELL_CSS in build-docs.ts and site/index.html
// so the diagram sits correctly on the README, the docs site, and the landing page.

interface Palette {
  bg: string;
  paper: string;
  ink: string;
  muted: string;
  border: string;
  clay: string;
  accentText: string;
}

const LIGHT: Palette = {
  bg: "#f6f8fa",
  paper: "#ffffff",
  ink: "#1f2328",
  muted: "#57606a",
  border: "rgba(0,0,0,.14)",
  clay: "#d97757",
  accentText: "#c15f3c",
};

const DARK: Palette = {
  bg: "#0d1117",
  paper: "#161b22",
  ink: "#e6edf3",
  muted: "#8b949e",
  border: "rgba(255,255,255,.16)",
  clay: "#d97757",
  accentText: "#d97757",
};

/**
 * Every paint is emitted as `var(--ct-token, <this file's own literal>)`.
 *
 * The stylesheet is what actually drives the colour, but the fallback is the file's
 * *own* theme rather than always the light one — so a renderer that strips CSS
 * entirely still gets a coherent diagram, and the dark file in particular does not
 * silently render as the light one. `render()` sets this once per output file; the
 * generator is single-pass and sequential, so a module-level binding is safe here and
 * saves threading a paint function through every draw call.
 */
let FALLBACK: Palette = LIGHT;
const v = (token: keyof Palette): string => `var(--ct-${token}, ${FALLBACK[token]})`;

function styleBlock(theme: "light" | "dark" | "auto"): string {
  const vars = (p: Palette) =>
    Object.entries(p)
      .map(([k, val]) => `--ct-${k}:${val}`)
      .join(";");
  const base = `:root{${vars(theme === "dark" ? DARK : LIGHT)}}`;
  const dark = theme === "auto" ? `@media(prefers-color-scheme:dark){:root{${vars(DARK)}}}` : "";
  return `<style>${base}${dark}</style>`;
}

// ── Layout constants ─────────────────────────────────────────────────────────

const MARGIN = 16;
// Wide enough for the longest edge label to sit in the gap between two columns
// without touching either box — the label strip is the constraint here, not the boxes.
const COL_GAP = 104;
const ROW_GAP = 16;
const PAD_X = 14;
const ICON = 20;
const ICON_GAP = 8;
const LABEL_SIZE = 13;
const CAPTION_SIZE = 10.5;
const EDGE_LABEL_SIZE = 9.5;
const BOX_H = 52;
const MIN_W = 118;
const GROUP_PAD = 13;
const GROUP_TITLE_H = 13;

type Placed = DiagramNode & { box: Box };

function boxWidth(node: DiagramNode): number {
  const label = measureText(node.label, LABEL_SIZE, true);
  const caption = node.caption ? measureText(node.caption, CAPTION_SIZE) : 0;
  const icon = node.icon ? ICON + ICON_GAP : 0;
  return Math.max(MIN_W, Math.ceil(Math.max(label, caption) + icon + 2 * PAD_X));
}

/**
 * `rank` gives the column; `lane` gives the horizontal band.
 *
 * The band is what makes the picture readable, and it falls straight out of ADR
 * 0016. The write lane (Claude Code → hook) runs along the top, the read lane
 * (clients → gateway) along the bottom, and the stores sit centred at the right
 * where both converge. Because the two lanes occupy different y bands, the hook's
 * long bypass to the stores passes *over* the gateway rather than through it, and
 * the clients' arrows to the gateway pass *under* the hook rather than through it —
 * which is exactly what the first attempt at this got wrong.
 */
const LANE_ORDER = ["write", "read"] as const;
const LANE_GAP = 34;

function layout(diagram: ArchitectureDiagram): { placed: Placed[]; width: number; height: number } {
  const ranks = [...new Set(diagram.nodes.map((d) => d.rank))].sort((a, b) => a - b);
  const colWidth = new Map(
    ranks.map((r) => [r, Math.max(...diagram.nodes.filter((d) => d.rank === r).map(boxWidth))]),
  );
  const colX = new Map<number, number>();
  let x = MARGIN;
  for (const r of ranks) {
    colX.set(r, x);
    x += (colWidth.get(r) as number) + COL_GAP;
  }
  const width = Math.ceil(x - COL_GAP + MARGIN);

  const cell = (lane: string, rank: number) =>
    diagram.nodes.filter((d) => d.lane === lane && d.rank === rank);
  const stackHeight = (count: number) => count * BOX_H + Math.max(0, count - 1) * ROW_GAP;

  // Band heights: a lane is as tall as its fullest column. Group hulls need padding
  // and a title strip above them, so reserve that inside the band that contains one.
  const laneHasGroup = new Set(
    diagram.groups.flatMap((g) =>
      g.members.map((m) => diagram.nodes.find((d) => d.key === m)?.lane ?? ""),
    ),
  );
  const laneHeight = LANE_ORDER.map((lane) => {
    const tallest = Math.max(0, ...ranks.map((r) => stackHeight(cell(lane, r).length)));
    return tallest + (laneHasGroup.has(lane) ? GROUP_PAD + GROUP_TITLE_H : 0);
  });

  const placed: Placed[] = [];
  let y = MARGIN + GROUP_TITLE_H;
  LANE_ORDER.forEach((lane, li) => {
    const h = laneHeight[li] as number;
    for (const r of ranks) {
      const nodes = cell(lane, r);
      if (!nodes.length) continue;
      let ny = y + (h - stackHeight(nodes.length)) / 2;
      for (const node of nodes) {
        placed.push({
          ...node,
          box: { x: colX.get(r) as number, y: ny, w: colWidth.get(r) as number, h: BOX_H },
        });
        ny += BOX_H + ROW_GAP;
      }
    }
    y += h + LANE_GAP;
  });
  const lanesBottom = y - LANE_GAP;

  // The stores straddle both lanes: centre them on the whole content block.
  const storeTop = MARGIN + GROUP_TITLE_H;
  for (const r of ranks) {
    const nodes = cell("store", r);
    if (!nodes.length) continue;
    let ny = storeTop + (lanesBottom - storeTop - stackHeight(nodes.length)) / 2;
    for (const node of nodes) {
      placed.push({
        ...node,
        box: { x: colX.get(r) as number, y: ny, w: colWidth.get(r) as number, h: BOX_H },
      });
      ny += BOX_H + ROW_GAP;
    }
  }

  const bottom = Math.max(...placed.map((p) => p.box.y + p.box.h));
  return { placed, width, height: Math.ceil(bottom + GROUP_PAD + MARGIN) };
}

// ── Painting ─────────────────────────────────────────────────────────────────

function nodeFill(role: DiagramNode["role"]): string {
  return role === "gateway" ? v("bg") : v("paper");
}

function nodeStroke(role: DiagramNode["role"]): string {
  return role === "gateway" || role === "writer" ? v("clay") : v("border");
}

function drawNode(node: Placed, icons: Map<string, Icon>, i: number): string {
  const { box } = node;
  const hasIcon = Boolean(node.icon);
  const textW = Math.max(
    measureText(node.label, LABEL_SIZE, true),
    node.caption ? measureText(node.caption, CAPTION_SIZE) : 0,
  );
  const blockW = textW + (hasIcon ? ICON + ICON_GAP : 0);
  const left = cx(box) - blockW / 2;
  const textX = hasIcon ? left + ICON + ICON_GAP + textW / 2 : cx(box);

  const parts = [
    rect(box, {
      rx: 9,
      fill: nodeFill(node.role),
      stroke: nodeStroke(node.role),
      "stroke-width": node.role === "gateway" ? 1.6 : 1,
    }),
  ];

  if (node.icon) {
    const icon = icons.get(node.icon);
    if (icon) {
      const slot: Box = { x: left, y: cy(box) - ICON / 2, w: ICON, h: ICON };
      parts.push(placeIcon(icon, slot, `ct-i${i}-`, node.icon === "claude" ? v("ink") : undefined));
    }
  }

  const labelY = node.caption ? cy(box) - 2 : cy(box) + 4.5;
  parts.push(
    text(textX, labelY, node.label, {
      "text-anchor": "middle",
      "font-size": LABEL_SIZE,
      "font-weight": 600,
      fill: v("ink"),
    }),
  );
  if (node.caption) {
    parts.push(
      text(textX, cy(box) + 13, node.caption, {
        "text-anchor": "middle",
        "font-size": CAPTION_SIZE,
        fill: v("muted"),
      }),
    );
  }
  return group({}, parts);
}

function drawGroup(g: ArchitectureDiagram["groups"][number], byKey: Map<string, Placed>): string {
  const boxes = g.members.map((m) => byKey.get(m)?.box).filter((b): b is Box => Boolean(b));
  if (!boxes.length) return "";
  const x = Math.min(...boxes.map((b) => b.x)) - GROUP_PAD;
  const y = Math.min(...boxes.map((b) => b.y)) - GROUP_PAD - GROUP_TITLE_H;
  const r = Math.max(...boxes.map((b) => b.x + b.w)) + GROUP_PAD;
  const bottom = Math.max(...boxes.map((b) => b.y + b.h)) + GROUP_PAD;
  return group({}, [
    rect(
      { x, y, w: r - x, h: bottom - y },
      {
        rx: 12,
        fill: "none",
        stroke: v("border"),
        "stroke-width": 1,
        "stroke-dasharray": "3 4",
      },
    ),
    text(x + GROUP_PAD, y + GROUP_TITLE_H, g.title.toUpperCase(), {
      "font-size": 8.5,
      "letter-spacing": 0.7,
      fill: v("muted"),
    }),
  ]);
}

interface EdgeStyle {
  stroke: string;
  dash?: string;
  markerId: string;
  labelFill: string;
}

function edgeStyle(kind: DiagramEdge["kind"]): EdgeStyle {
  if (kind === "direct-write") {
    return {
      stroke: v("clay"),
      dash: "5 4",
      markerId: "ct-arrow-clay",
      labelFill: v("accentText"),
    };
  }
  if (kind === "emits") {
    return { stroke: v("clay"), markerId: "ct-arrow-clay", labelFill: v("accentText") };
  }
  return { stroke: v("muted"), markerId: "ct-arrow-muted", labelFill: v("muted") };
}

/** Where an elbow's label sits — see the comment at the call site. */
function labelSpot(
  edge: DiagramEdge,
  a: Point,
  head: Point,
  fromBox: Box,
  toBox: Box,
  fanOut: Map<string, number>,
  fanIn: Map<string, number>,
): { mx: number; my: number } {
  const out = fanOut.get(edge.from) ?? 1;
  const into = fanIn.get(edge.to) ?? 1;
  // Always horizontally centred in the gap between the two columns — the only strip
  // guaranteed free of boxes. Only the *height* varies: take the y of whichever end
  // fans out, so a bundle of edges is spread by its boxes' own spacing.
  const mx = (fromBox.x + fromBox.w + toBox.x) / 2;
  if (into > out) return { mx, my: a.y - 6 };
  if (out > into) return { mx, my: head.y - 6 };
  return { mx, my: (a.y + head.y) / 2 - 6 };
}

/**
 * Route an edge. Rank-to-rank edges get a rounded orthogonal elbow, which reads calm
 * and flat; the hook's two bypass edges get a straight dashed diagonal, because a
 * line visibly *skipping over* the gateway box is the most informative mark in the
 * picture — it is the fact every hand-drawn version got backwards.
 */
function drawEdge(
  edge: DiagramEdge,
  byKey: Map<string, Placed>,
  faceIndex: Map<string, { i: number; of: number }>,
  fanOut: Map<string, number>,
  fanIn: Map<string, number>,
): string {
  const from = byKey.get(edge.from);
  const to = byKey.get(edge.to);
  if (!from || !to) return "";
  const style = edgeStyle(edge.kind);
  const diagonal = edge.kind === "direct-write";

  let a: Point;
  let b: Point;
  if (diagonal) {
    a = anchorOnRect(from.box, { x: cx(to.box), y: cy(to.box) });
    b = anchorOnRect(to.box, { x: cx(from.box), y: cy(from.box) });
  } else {
    const outSlot = faceIndex.get(`${edge.from}|r|${edge.to}`) ?? { i: 0, of: 1 };
    const inSlot = faceIndex.get(`${edge.to}|l|${edge.from}`) ?? { i: 0, of: 1 };
    a = anchorOnFace(from.box, "r", outSlot.i, outSlot.of);
    b = anchorOnFace(to.box, "l", inSlot.i, inSlot.of);
  }
  const head = shorten(a, b, MARKER_LEN + 1);
  // Transit early when the bundle fans out from the source, late when it fans in on
  // the target — the opposite end from where labelSpot puts the label.
  const out = fanOut.get(edge.from) ?? 1;
  const into = fanIn.get(edge.to) ?? 1;
  const transit = into > out ? 0.68 : out > into ? 0.32 : 0.5;
  const d = diagonal ? line(a, head) : orthPath(a, head, transit);

  const attrs: Attrs = {
    d,
    fill: "none",
    stroke: style.stroke,
    "stroke-width": 1.4,
    "marker-end": `url(#${style.markerId})`,
  };
  if (style.dash) attrs["stroke-dasharray"] = style.dash;
  const parts = [el("path", attrs)];

  if (edge.label) {
    // Place the label on the end of the elbow that fans *out*, so labels on a bundle
    // of edges are separated by their boxes' own spacing rather than by the few
    // pixels between anchor points on the shared box's face. Three clients converging
    // on the gateway get labelled at their own ends; the gateway's three edges to the
    // stores get labelled at the stores' ends. Anything one-to-one takes the midpoint.
    const { mx, my } = diagonal
      ? { mx: (a.x + head.x) / 2, my: (a.y + head.y) / 2 - 6 }
      : labelSpot(edge, a, head, from.box, to.box, fanOut, fanIn);
    // A halo in the page background keeps the label legible where it crosses a line.
    parts.push(
      text(mx, my, edge.label, {
        "text-anchor": "middle",
        "font-size": EDGE_LABEL_SIZE,
        fill: style.labelFill,
        stroke: v("bg"),
        "stroke-width": 3,
        "paint-order": "stroke",
      }),
    );
  }
  return group({}, parts);
}

// ── Document ─────────────────────────────────────────────────────────────────

const BANNER = `<!-- GENERATED from the app model (@claude-transcripts/shared) by scripts/gen-diagram.ts.
     Do NOT edit by hand — run \`bun run gen:diagram\`. Edit the model:
     packages/shared/src/model/topology.ts (nodes/edges) and services.ts (names/ports). -->`;

function render(
  diagram: ArchitectureDiagram,
  icons: Map<string, Icon>,
  theme: "light" | "dark" | "auto",
): string {
  FALLBACK = theme === "dark" ? DARK : LIGHT;
  const { placed, width, height } = layout(diagram);
  const byKey = new Map(placed.map((p) => [p.key, p]));

  // How many edges share each face, so anchors can be spread rather than stacked.
  const faceIndex = new Map<string, { i: number; of: number }>();
  for (const face of ["r", "l"] as const) {
    const key = face === "r" ? "from" : "to";
    const groups = new Map<string, DiagramEdge[]>();
    for (const e of diagram.edges) {
      if (e.kind === "direct-write") continue;
      const owner = e[key];
      const list = groups.get(owner) ?? [];
      list.push(e);
      groups.set(owner, list);
    }
    for (const [owner, list] of groups) {
      const sorted = [...list].sort((p, q) => {
        const other = face === "r" ? "to" : "from";
        return (byKey.get(p[other])?.box.y ?? 0) - (byKey.get(q[other])?.box.y ?? 0);
      });
      sorted.forEach((e, i) => {
        const other = face === "r" ? e.to : e.from;
        faceIndex.set(`${owner}|${face}|${other}`, { i, of: sorted.length });
      });
    }
  }

  // How many edges leave each node and arrive at each node — drives label placement.
  const fanOut = new Map<string, number>();
  const fanIn = new Map<string, number>();
  for (const e of diagram.edges) {
    fanOut.set(e.from, (fanOut.get(e.from) ?? 0) + 1);
    fanIn.set(e.to, (fanIn.get(e.to) ?? 0) + 1);
  }

  const defs = el("defs", {}, [
    marker("ct-arrow-muted", v("muted")),
    marker("ct-arrow-clay", v("clay")),
  ]);

  const body = [
    // <title> and <desc> first: the SVG spec wants the accessible name ahead of the
    // content it names, and assistive tech reads in document order.
    el("title", { id: "ct-title" }, [escapeXml(`${diagram.title} — architecture`)]),
    el("desc", { id: "ct-desc" }, [escapeXml(diagram.description)]),
    defs,
    styleBlock(theme),
    rect({ x: 0, y: 0, w: width, h: height }, { fill: v("bg") }),
    ...diagram.groups.map((g) => drawGroup(g, byKey)),
    ...diagram.edges.map((e) => drawEdge(e, byKey, faceIndex, fanOut, fanIn)),
    ...placed.map((p, i) => drawNode(p, icons, i)),
  ].join("");

  const svg = el(
    "svg",
    {
      xmlns: "http://www.w3.org/2000/svg",
      viewBox: `0 0 ${width} ${height}`,
      width,
      height,
      role: "img",
      "aria-labelledby": "ct-title ct-desc",
      "font-family": FONT_STACK,
    },
    [body],
  );
  return `${BANNER}\n${svg}\n`;
}

// ── Main ─────────────────────────────────────────────────────────────────────

const model = buildAppModel(loadConfigTemplate(ROOT), {});
const diagram = toArchitectureDiagram(model, { level: "compact" });

/** IconKey → file. `mark` is our own logo, referenced in place rather than copied. */
const ICON_FILES: Record<string, string> = {
  mark: join(ROOT, "brand", "logo-mark.svg"),
  claude: join(ROOT, "brand", "icons", "claude.svg"),
  couchdb: join(ROOT, "brand", "icons", "couchdb.svg"),
  garage: join(ROOT, "brand", "icons", "garage.svg"),
  meilisearch: join(ROOT, "brand", "icons", "meilisearch.svg"),
};

const icons = new Map<string, Icon>(
  [...new Set(diagram.nodes.map((d) => d.icon).filter((k): k is string => Boolean(k)))].map((k) => {
    const file = ICON_FILES[k];
    if (!file) throw new Error(`gen-diagram: no file mapped for icon "${k}"`);
    return [k, loadIcon(file)];
  }),
);

const OUTPUTS: { file: string; theme: "light" | "dark" | "auto" }[] = [
  { file: "architecture.svg", theme: "auto" },
  { file: "architecture-light.svg", theme: "light" },
  { file: "architecture-dark.svg", theme: "dark" },
];

for (const { file, theme } of OUTPUTS) {
  await Bun.write(join(ROOT, "docs", "assets", file), render(diagram, icons, theme));
}

console.log(
  `[gen-diagram] wrote docs/assets/architecture{,-light,-dark}.svg ` +
    `(${diagram.nodes.length} nodes, ${diagram.edges.length} edges)`,
);

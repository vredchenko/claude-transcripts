/**
 * Static docs builder — renders `docs/*.md` (+ `docs/design/decisions/*.md`) into a
 * self-contained, theme-aware HTML site. Dependency-free on purpose: it uses only
 * Bun + Node built-ins so it needs no npm install (keeps CI's `--frozen-lockfile`
 * green) and produces fully offline output — the same output feeds both GitHub
 * Pages (`site/docs/`) and the combined app image (served by the webapi at `/docs`).
 *
 * The Markdown renderer is a deliberately small GFM subset (headings, paragraphs,
 * fenced/inline code, bold/italic, links, images, tables, blockquotes, nested
 * lists, hr). It is meant to be good enough for our docs and swappable for a full
 * SSG later — see docs/develop/dev-automation.md.
 *
 * Usage: `bun run scripts/build-docs.ts [--out <dir>]`  (default: build/docs)
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, normalize } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..");
const DOCS_DIR = join(REPO_ROOT, "docs");

/** Sentinel wrapping a protected inline-code index; printable + unlikely in docs. */
const CODE_OPEN = "@@ctcode";
const CODE_CLOSE = "ctcode@@";

function parseOutDir(argv: string[]): string {
  const i = argv.indexOf("--out");
  const raw = i >= 0 && argv[i + 1] ? argv[i + 1] : "build/docs";
  return raw.startsWith("/") ? raw : join(REPO_ROOT, raw);
}

/**
 * The published section order + labels. `dir` is a directory under `docs/`
 * (empty string = the docs root, i.e. the overview page); `lead` names the files
 * that should sort first within a section — everything else follows
 * alphabetically. Adding a doc needs no change here; adding a *section* does.
 */
interface Section {
  dir: string;
  title: string;
  /** Blurb rendered under the section heading on the docs index. */
  blurb?: string;
  lead?: string[];
}

const SECTIONS: Section[] = [
  { dir: "", title: "Overview" },
  {
    dir: "start",
    title: "Getting started",
    blurb: "Install it, point it at your stores, and record your first session.",
    lead: ["installation.md", "configuration.md", "hook-setup.md"],
  },
  {
    dir: "develop",
    title: "Development",
    blurb: "Working on Claude Transcripts itself: setup, conventions, tests, automation.",
    lead: ["getting-started.md", "development.md"],
  },
  {
    dir: "operate",
    title: "Operations",
    blurb: "Running and shipping it: releases, containers, migrations, logs.",
    lead: ["releasing.md", "containers.md"],
  },
  {
    dir: "reference",
    title: "Reference",
    blurb: "Per-component and per-surface detail — the codebase as documented.",
    lead: ["webapi.md", "webui.md", "cli.md"],
  },
  {
    dir: "design",
    title: "Design & specification",
    blurb: "What the system is meant to be, and the reasoning behind it.",
    lead: ["specification.md", "architecture.md", "tiers.md", "roadmap.md"],
  },
  {
    dir: "design/decisions",
    title: "Decisions (ADRs)",
    blurb: "One record per architectural decision, in the order they were taken.",
  },
];

interface Page {
  /** Absolute source path. */
  src: string;
  /** Output path relative to the out dir, e.g. "design/tiers.html". */
  outRel: string;
  /** Nesting depth of the output file (0 = root, 1 = start/, 2 = design/decisions/). */
  depth: number;
  title: string;
  /** Section title this page is grouped under in the nav. */
  group: string;
}

function stripInlineMarkers(s: string): string {
  return s.replace(/[`*_]/g, "").trim();
}

/** First H1 in the source, else a title derived from the file name. */
function extractTitle(md: string, fallback: string): string {
  for (const line of md.split("\n")) {
    const m = /^#\s+(.+?)\s*$/.exec(line);
    if (m) return stripInlineMarkers(m[1]);
  }
  return fallback;
}

function titleCaseFromSlug(slug: string): string {
  return slug
    .replace(/\.md$/, "")
    .replace(/[-_]/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * Order files: a section's own README (its index) first, then the section's
 * `lead` list, then everything else alphabetically.
 */
function orderFiles(files: string[], lead: string[] = []): string[] {
  const rank = (f: string) => {
    if (f === "README.md") return -1;
    const i = lead.indexOf(f);
    return i === -1 ? lead.length : i;
  };
  return [...files].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
}

function collectPages(): Page[] {
  const pages: Page[] = [];

  for (const section of SECTIONS) {
    const dir = section.dir ? join(DOCS_DIR, section.dir) : DOCS_DIR;
    if (!existsSync(dir)) continue;
    const files = orderFiles(
      readdirSync(dir).filter((f) => f.endsWith(".md")),
      section.lead,
    );

    for (const file of files) {
      const src = join(dir, file);
      const md = readFileSync(src, "utf8");
      // Any README.md is its directory's index page — the docs root's becomes the
      // site index, a section's becomes that section's (e.g. the ADR index).
      // rewriteLink maps `README.md` links onto the same `index.html`.
      const isIndex = file === "README.md";
      const stem = isIndex ? "index" : file.replace(/\.md$/, "");
      const outRel = section.dir ? `${section.dir}/${stem}.html` : `${stem}.html`;
      pages.push({
        src,
        outRel,
        depth: outRel.split("/").length - 1,
        title:
          section.dir === "" && isIndex ? "Overview" : extractTitle(md, titleCaseFromSlug(file)),
        group: section.title,
      });
    }
  }

  return pages;
}

// ── Markdown → HTML ─────────────────────────────────────────────────────────

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function slugify(text: string): string {
  return stripInlineMarkers(text)
    .toLowerCase()
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-");
}

/** Blob root for links that point at repo files rather than docs pages. */
const GITHUB_BLOB = "https://github.com/vredchenko/claude-transcripts/blob/main";

/**
 * Directory (relative to `docs/`) of the page currently being rendered, and the
 * broken links found so far. Module-level because the renderer is a synchronous
 * pipeline of pure string functions — threading a context object through every
 * inline/block helper would cost more than it buys.
 */
let currentDir = "";
const brokenLinks: string[] = [];

/**
 * Rewrite a relative link for the published site:
 *  - `*.md` inside docs/ → the corresponding `.html` (existence-checked)
 *  - anything that escapes docs/ (`../../config/…`) → a GitHub blob URL, since
 *    the published site contains only the docs tree
 */
function rewriteLink(href: string): string {
  if (/^[a-z]+:/i.test(href) || href.startsWith("#") || href.startsWith("//")) return href;
  const [path, anchor] = href.split("#");
  if (!path) return href;

  // Resolve against the page's own directory to see where it lands.
  const resolved = normalize(join(currentDir, path));
  if (resolved.startsWith("..")) {
    const repoPath = resolved.replace(/^(\.\.\/)+/, "");
    return `${GITHUB_BLOB}/${repoPath}`;
  }

  if (!path.endsWith(".md")) return href;
  if (!existsSync(join(DOCS_DIR, resolved))) {
    brokenLinks.push(`${currentDir || "."}: ${href}`);
  }
  // A directory's README.md is published as its index.html.
  const html = path.replace(/(^|\/)README\.md$/, "$1index.md").replace(/\.md$/, ".html");
  return anchor ? `${html}#${anchor}` : html;
}

/** Inline formatting. Escapes HTML, then applies code/links/images/bold/italic. */
function renderInline(text: string): string {
  // Protect inline code spans first so their contents are not further parsed.
  const codeSpans: string[] = [];
  let out = text.replace(/`([^`]+)`/g, (_m, code: string) => {
    codeSpans.push(`<code>${escapeHtml(code)}</code>`);
    return `${CODE_OPEN}${codeSpans.length - 1}${CODE_CLOSE}`;
  });

  out = escapeHtml(out);

  // Images before links (same bracket shape).
  out = out.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_m, alt: string, src: string) => {
    return `<img src="${rewriteLink(src)}" alt="${alt}" />`;
  });
  out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, label: string, href: string) => {
    const external = /^[a-z]+:/i.test(href);
    const attrs = external ? ' target="_blank" rel="noopener noreferrer"' : "";
    return `<a href="${rewriteLink(href)}"${attrs}>${label}</a>`;
  });

  out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  out = out.replace(/__([^_]+)__/g, "<strong>$1</strong>");
  out = out.replace(/(^|[^*])\*([^*\s][^*]*?)\*/g, "$1<em>$2</em>");
  out = out.replace(/(^|[^\w])_([^_\s][^_]*?)_/g, "$1<em>$2</em>");

  const decode = new RegExp(`${CODE_OPEN}(\\d+)${CODE_CLOSE}`, "g");
  out = out.replace(decode, (_m, i: string) => codeSpans[Number(i)]);
  return out;
}

function renderTableRow(cells: string[], tag: "td" | "th"): string {
  const inner = cells.map((c) => `<${tag}>${renderInline(c.trim())}</${tag}>`).join("");
  return `<tr>${inner}</tr>`;
}

function splitTableRow(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  return trimmed.split("|");
}

/** Render a contiguous block of list lines (already sliced) into nested <ul>/<ol>. */
function renderList(lines: string[]): string {
  interface Item {
    indent: number;
    ordered: boolean;
    content: string;
  }
  const items: Item[] = [];
  for (const line of lines) {
    const m = /^(\s*)([-*+]|\d+\.)\s+(.*)$/.exec(line);
    if (!m) {
      // Continuation of the previous item's text (wrapped line).
      if (items.length > 0) items[items.length - 1].content += ` ${line.trim()}`;
      continue;
    }
    items.push({
      indent: m[1].replace(/\t/g, "  ").length,
      ordered: /\d/.test(m[2]),
      content: m[3],
    });
  }

  let html = "";
  const stack: { indent: number; ordered: boolean }[] = [];
  for (const item of items) {
    while (stack.length > 0 && item.indent < stack[stack.length - 1].indent) {
      const closed = stack.pop();
      html += closed?.ordered ? "</ol>" : "</ul>";
    }
    const top = stack[stack.length - 1];
    if (!top || item.indent > top.indent) {
      stack.push({ indent: item.indent, ordered: item.ordered });
      html += item.ordered ? "<ol>" : "<ul>";
    }
    html += `<li>${renderInline(item.content)}</li>`;
  }
  while (stack.length > 0) {
    const closed = stack.pop();
    html += closed?.ordered ? "</ol>" : "</ul>";
  }
  return html;
}

function renderMarkdown(md: string): string {
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  const html: string[] = [];
  let i = 0;

  const isListLine = (s: string) => /^\s*([-*+]|\d+\.)\s+/.test(s);

  while (i < lines.length) {
    const line = lines[i];

    // Fenced code block.
    const fence = /^```\s*([\w-]*)\s*$/.exec(line);
    if (fence) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) {
        body.push(lines[i]);
        i++;
      }
      i++; // closing fence
      html.push(`<pre><code>${escapeHtml(body.join("\n"))}\n</code></pre>`);
      continue;
    }

    // Blank line.
    if (line.trim() === "") {
      i++;
      continue;
    }

    // Heading.
    const heading = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (heading) {
      const level = heading[1].length;
      const id = slugify(heading[2]);
      html.push(`<h${level} id="${id}">${renderInline(heading[2])}</h${level}>`);
      i++;
      continue;
    }

    // Horizontal rule.
    if (/^(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      html.push("<hr />");
      i++;
      continue;
    }

    // Table (a header row followed by a `---|---` separator).
    const nextIsSeparator = i + 1 < lines.length && /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(lines[i + 1]);
    if (line.includes("|") && nextIsSeparator) {
      const header = splitTableRow(line);
      i += 2; // header + separator
      const rows: string[] = [];
      while (i < lines.length && lines[i].includes("|") && lines[i].trim() !== "") {
        rows.push(renderTableRow(splitTableRow(lines[i]), "td"));
        i++;
      }
      html.push(
        `<table><thead>${renderTableRow(header, "th")}</thead><tbody>${rows.join("")}</tbody></table>`,
      );
      continue;
    }

    // Blockquote.
    if (/^\s*>/.test(line)) {
      const body: string[] = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) {
        body.push(lines[i].replace(/^\s*>\s?/, ""));
        i++;
      }
      html.push(`<blockquote>${renderMarkdown(body.join("\n"))}</blockquote>`);
      continue;
    }

    // List.
    if (isListLine(line)) {
      const body: string[] = [];
      while (
        i < lines.length &&
        lines[i].trim() !== "" &&
        (isListLine(lines[i]) || /^\s+\S/.test(lines[i]))
      ) {
        body.push(lines[i]);
        i++;
      }
      html.push(renderList(body));
      continue;
    }

    // Paragraph (accumulate until a blank line or a block starter).
    const para: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() !== "" &&
      !/^(#{1,6})\s/.test(lines[i]) &&
      !/^```/.test(lines[i]) &&
      !/^\s*>/.test(lines[i]) &&
      !isListLine(lines[i])
    ) {
      para.push(lines[i]);
      i++;
    }
    html.push(`<p>${renderInline(para.join(" "))}</p>`);
  }

  return html.join("\n");
}

// ── Page shell ──────────────────────────────────────────────────────────────

const MARK_SVG = [
  '<svg viewBox="0 0 32 32" width="26" height="26" role="img" aria-label="Claude Transcripts">',
  '<rect width="32" height="32" rx="7" fill="#d97757"/>',
  '<rect x="7" y="8.5" width="12" height="2.8" rx="1.4" fill="#fff" fill-opacity="0.96"/>',
  '<rect x="7" y="14.6" width="18" height="2.8" rx="1.4" fill="#fff" fill-opacity="0.74"/>',
  '<rect x="7" y="20.7" width="9" height="2.8" rx="1.4" fill="#fff" fill-opacity="0.96"/></svg>',
].join("");

/** `../` repeated to climb from a page back to the docs root. */
function upToRoot(depth: number): string {
  return "../".repeat(depth);
}

function buildNav(pages: Page[], current: Page): string {
  const prefix = upToRoot(current.depth);
  const parts: string[] = [];
  for (const section of SECTIONS) {
    const inGroup = pages.filter((p) => p.group === section.title);
    if (inGroup.length === 0) continue;
    // The docs root holds only the index — it needs no group heading of its own.
    if (section.dir !== "") parts.push(`<div class="nav-group">${escapeHtml(section.title)}</div>`);
    for (const p of inGroup) {
      const active = p.outRel === current.outRel ? ' class="active"' : "";
      parts.push(`<a href="${prefix}${p.outRel}"${active}>${escapeHtml(p.title)}</a>`);
    }
  }
  return parts.join("\n");
}

/**
 * The index page's section directory: every published page, grouped, with each
 * section's blurb. Generated so it can never drift from what actually shipped —
 * `docs/README.md` stays a short intro and doesn't restate the file list.
 */
function buildIndexSections(pages: Page[]): string {
  const parts: string[] = ['<div class="sections">'];
  for (const section of SECTIONS) {
    if (section.dir === "") continue;
    const inGroup = pages.filter((p) => p.group === section.title);
    if (inGroup.length === 0) continue;
    parts.push('<section class="section-card">');
    parts.push(`<h2 id="${slugify(section.title)}">${escapeHtml(section.title)}</h2>`);
    if (section.blurb) parts.push(`<p class="blurb">${escapeHtml(section.blurb)}</p>`);
    parts.push("<ul>");
    for (const p of inGroup) {
      parts.push(`<li><a href="${p.outRel}">${escapeHtml(p.title)}</a></li>`);
    }
    parts.push("</ul></section>");
  }
  parts.push("</div>");
  return parts.join("");
}

/**
 * Project-status banner shown on every docs page. The project is not tested as
 * ready for use; say so wherever the docs are published (Pages + the app image).
 */
const WIP_BANNER = [
  '<div class="wip">',
  '<span class="wip-tag">Work in progress</span>',
  "<strong>Under active development — not tested as ready for use.</strong> ",
  "Breaking changes land without notice, stored data may need to be discarded ",
  "between revisions, and there is no auth or security model. These docs describe ",
  "the intended design as much as the current state.",
  "</div>",
].join("");

function renderShell(page: Page, content: string, nav: string): string {
  const prefix = upToRoot(page.depth);
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <link rel="icon" type="image/svg+xml" href="${prefix}favicon.svg" />
    <title>${escapeHtml(page.title)} · Claude Transcripts docs</title>
    <style>${SHELL_CSS}</style>
  </head>
  <body>
    <header class="topbar">
      <a class="brand" href="${prefix}index.html">${MARK_SVG}<span>Claude Transcripts <em>docs</em></span></a>
      <a class="repo" href="https://github.com/vredchenko/claude-transcripts">GitHub</a>
    </header>
    <div class="layout">
      <nav class="sidebar">${nav}</nav>
      <main class="content">${WIP_BANNER}${content}</main>
    </div>
  </body>
</html>
`;
}

const SHELL_CSS = `
:root{--clay:#d97757;--clay-deep:#c15f3c;--bg:#f6f8fa;--paper:#fff;--ink:#1f2328;--muted:#57606a;--border:rgba(0,0,0,.1);--code:#eef1f4}
@media (prefers-color-scheme:dark){:root{--bg:#0d1117;--paper:#161b22;--ink:#e6edf3;--muted:#8b949e;--border:rgba(255,255,255,.12);--code:#0d1117}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;line-height:1.6}
a{color:var(--clay-deep)}@media (prefers-color-scheme:dark){a{color:var(--clay)}}
.topbar{position:sticky;top:0;display:flex;align-items:center;gap:12px;padding:10px 20px;background:var(--paper);border-bottom:1px solid var(--border);z-index:10}
.brand{display:flex;align-items:center;gap:8px;text-decoration:none;color:var(--ink);font-weight:700}
.brand em{font-style:normal;color:var(--muted);font-weight:500}
.topbar .repo{margin-left:auto;text-decoration:none;color:var(--muted);font-size:14px}
.layout{display:flex;max-width:1120px;margin:0 auto;gap:8px}
.sidebar{flex:0 0 240px;padding:24px 8px 48px;position:sticky;top:52px;align-self:flex-start;height:calc(100vh - 52px);overflow-y:auto}
.sidebar a{display:block;padding:5px 12px;border-radius:6px;text-decoration:none;color:var(--muted);font-size:14px}
.sidebar a:hover{background:var(--border);color:var(--ink)}
.sidebar a.active{background:var(--clay);color:#fff}
.nav-group{margin:16px 12px 6px;font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);font-weight:700}
.content{flex:1 1 auto;min-width:0;padding:28px 28px 80px;max-width:820px}
.content h1{font-size:30px;margin:.2em 0 .6em;letter-spacing:-.02em}
.content h2{margin-top:1.6em;border-bottom:1px solid var(--border);padding-bottom:.3em}
.content code{background:var(--code);border:1px solid var(--border);border-radius:5px;padding:.1em .35em;font-size:.88em;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
.content pre{background:var(--code);border:1px solid var(--border);border-radius:10px;padding:14px 16px;overflow-x:auto}
.content pre code{background:none;border:none;padding:0}
.content table{border-collapse:collapse;width:100%;margin:1em 0;display:block;overflow-x:auto}
.content th,.content td{border:1px solid var(--border);padding:7px 11px;text-align:left;vertical-align:top}
.content th{background:var(--paper)}
.content blockquote{margin:1em 0;padding:.4em 1em;border-left:3px solid var(--clay);background:var(--paper);color:var(--muted);border-radius:0 8px 8px 0}
.content img{max-width:100%}
.wip{background:var(--paper);border:1px solid var(--clay);border-left:4px solid var(--clay);border-radius:10px;padding:12px 16px;margin:0 0 24px;font-size:14px;color:var(--muted)}
.wip strong{color:var(--ink)}
.wip-tag{display:inline-block;background:var(--clay);color:#fff;border-radius:5px;padding:1px 8px;font-size:11px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;margin-right:8px;vertical-align:1px}
.content hr{border:none;border-top:1px solid var(--border);margin:2em 0}
.sections{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:16px;margin:2em 0}
.section-card{background:var(--paper);border:1px solid var(--border);border-radius:10px;padding:4px 18px 16px}
.section-card h2{margin-top:1em;font-size:17px;border:none;padding:0}
.section-card .blurb{color:var(--muted);font-size:13.5px;margin:.3em 0 .7em}
.section-card ul{margin:0;padding-left:18px}
.section-card li{font-size:14px;margin:.18em 0}
@media (max-width:800px){.layout{flex-direction:column}.sidebar{position:static;height:auto;flex-basis:auto;border-bottom:1px solid var(--border)}}
`;

// ── Build ─────────────────────────────────────────────────────────────────

function main(): void {
  const outDir = parseOutDir(process.argv.slice(2));
  const pages = collectPages();

  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });

  // Favicon (mark) — keep the docs site self-contained.
  const favicon = join(REPO_ROOT, "brand", "logo-mark.svg");
  if (existsSync(favicon)) {
    writeFileSync(join(outDir, "favicon.svg"), readFileSync(favicon, "utf8"));
  }

  for (const page of pages) {
    const md = readFileSync(page.src, "utf8");
    // Link rewriting resolves against the page's own directory (see rewriteLink).
    currentDir = dirname(page.outRel) === "." ? "" : dirname(page.outRel);
    const body = renderMarkdown(md);
    // The site index gets the generated section directory appended, so the full
    // page list is never hand-maintained.
    const content = page.outRel === "index.html" ? body + buildIndexSections(pages) : body;
    const nav = buildNav(pages, page);
    const outPath = join(outDir, page.outRel);
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, renderShell(page, content, nav));
  }

  console.log(`Rendered ${pages.length} docs pages → ${outDir}`);

  if (brokenLinks.length > 0) {
    console.error(`\n${brokenLinks.length} broken internal doc link(s):`);
    for (const b of brokenLinks) console.error(`  ${b}`);
    process.exit(1);
  }
}

main();

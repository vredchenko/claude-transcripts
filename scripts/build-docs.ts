/**
 * Static docs builder — renders `docs/*.md` (+ `docs/decisions/*.md`) into a
 * self-contained, theme-aware HTML site. Dependency-free on purpose: it uses only
 * Bun + Node built-ins so it needs no npm install (keeps CI's `--frozen-lockfile`
 * green) and produces fully offline output — the same output feeds both GitHub
 * Pages (`site/docs/`) and the combined app image (served by the webapi at `/docs`).
 *
 * The Markdown renderer is a deliberately small GFM subset (headings, paragraphs,
 * fenced/inline code, bold/italic, links, images, tables, blockquotes, nested
 * lists, hr). It is meant to be good enough for our docs and swappable for a full
 * SSG later — see docs/dev-automation.md.
 *
 * Usage: `bun run scripts/build-docs.ts [--out <dir>]`  (default: build/docs)
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

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

interface Page {
  /** Absolute source path. */
  src: string;
  /** Output path relative to the out dir, e.g. "tiers.html" or "decisions/0001.html". */
  outRel: string;
  /** Nesting depth of the output file (0 = root, 1 = decisions/). */
  depth: number;
  title: string;
  group: "Docs" | "Decisions";
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

function collectPages(): Page[] {
  const pages: Page[] = [];
  const top = readdirSync(DOCS_DIR)
    .filter((f) => f.endsWith(".md"))
    .sort();

  for (const file of top) {
    const src = join(DOCS_DIR, file);
    const md = readFileSync(src, "utf8");
    if (file === "README.md") {
      pages.push({ src, outRel: "index.html", depth: 0, title: "Overview", group: "Docs" });
    } else {
      pages.push({
        src,
        outRel: `${file.replace(/\.md$/, "")}.html`,
        depth: 0,
        title: extractTitle(md, titleCaseFromSlug(file)),
        group: "Docs",
      });
    }
  }

  const decisionsDir = join(DOCS_DIR, "decisions");
  if (existsSync(decisionsDir)) {
    const decisions = readdirSync(decisionsDir)
      .filter((f) => f.endsWith(".md") && f !== "README.md")
      .sort();
    for (const file of decisions) {
      const src = join(decisionsDir, file);
      const md = readFileSync(src, "utf8");
      pages.push({
        src,
        outRel: `decisions/${file.replace(/\.md$/, "")}.html`,
        depth: 1,
        title: extractTitle(md, titleCaseFromSlug(file)),
        group: "Decisions",
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

/** Rewrite a relative `*.md` link (with optional #anchor) to its `.html` output. */
function rewriteLink(href: string): string {
  if (/^[a-z]+:/i.test(href) || href.startsWith("#") || href.startsWith("//")) return href;
  const [path, anchor] = href.split("#");
  if (!path.endsWith(".md")) return href;
  const html = path.replace(/\.md$/, ".html");
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

function buildNav(pages: Page[], current: Page): string {
  const prefix = current.depth === 1 ? "../" : "";
  const groups: Page["group"][] = ["Docs", "Decisions"];
  const parts: string[] = [];
  for (const group of groups) {
    const inGroup = pages.filter((p) => p.group === group);
    if (inGroup.length === 0) continue;
    parts.push(`<div class="nav-group">${group}</div>`);
    for (const p of inGroup) {
      const active = p.outRel === current.outRel ? ' class="active"' : "";
      parts.push(`<a href="${prefix}${p.outRel}"${active}>${escapeHtml(p.title)}</a>`);
    }
  }
  return parts.join("\n");
}

function renderShell(page: Page, content: string, nav: string): string {
  const prefix = page.depth === 1 ? "../" : "";
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
      <main class="content">${content}</main>
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
.content hr{border:none;border-top:1px solid var(--border);margin:2em 0}
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
    const content = renderMarkdown(md);
    const nav = buildNav(pages, page);
    const outPath = join(outDir, page.outRel);
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, renderShell(page, content, nav));
  }

  console.log(`Rendered ${pages.length} docs pages → ${outDir}`);
}

main();

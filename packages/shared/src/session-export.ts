/**
 * Render one session as a standalone document — Markdown to download, or HTML to print
 * (the browser's "Save as PDF" does the PDF). Pure and isomorphic: the webui uses it
 * today, and a CLI `export` can project from the same functions later.
 *
 * Input is the pruned transcript projection (`ChunkEntry`, ADR 0027) both transcript
 * sources serve. That projection carries assistant/user text, tool *names* and tool
 * result text — not thinking blocks or tool inputs — so the export can't show them
 * either.
 */
import type { ChunkEntry } from "./index";

/** The session facts printed above the transcript. All optional bar the id. */
export interface SessionExportMeta {
  sessionId: string;
  cwd?: string;
  model?: string;
  hostname?: string;
  /** `ended`, `running`, `incomplete` — decides whether `endTimestamp` is an end. */
  status?: string;
  startTimestamp?: string;
  /** When it ended — or, for a session that hasn't, its last write. */
  endTimestamp?: string;
  totalTokens?: number;
}

/**
 * What the export reads from a transcript entry: a `ChunkEntry`, loosened to accept
 * the nullable fields the generated API clients type it with.
 */
export interface ExportEntry {
  role: ChunkEntry["role"];
  timestamp?: string;
  text?: string;
  toolUses?: readonly { name: string; id?: string | null }[] | null;
  /** For a tool result: the tool_use id it answers. */
  toolUseId?: string | null;
  isError?: boolean;
  isSidechain?: boolean;
}

export interface SessionExportOptions {
  /** Tool calls and their results. Default true. */
  includeTools?: boolean;
  /** Characters of each tool result kept before truncating. Default 2000. */
  toolResultLimit?: number;
}

/** One section of the exported document. */
export interface ExportSection {
  role: "user" | "assistant" | "tool_result";
  timestamp?: string;
  text: string;
  /** Tool calls made in this (assistant) section, in order. */
  tools: string[];
  /** For a tool result: the name of the tool that produced it, when known. */
  tool?: string;
  isError: boolean;
  /** Part of a subagent sub-transcript. */
  sidechain: boolean;
  /** For a tool result: how many characters were cut. */
  truncated: number;
}

const DEFAULT_TOOL_RESULT_LIMIT = 2000;

const HEADINGS: Record<ExportSection["role"], string> = {
  user: "You",
  assistant: "Claude",
  tool_result: "Tool result",
};

/**
 * Reduce transcript entries to the sections worth reading. Drops non-turn lines
 * (attachments, snapshots, system notes) and empty turns, and merges consecutive
 * assistant lines — Claude Code writes one line per content block, so a single reply
 * otherwise arrives as a stack of "Claude" headings.
 */
export function sessionExportSections(
  entries: readonly ExportEntry[],
  options: SessionExportOptions = {},
): ExportSection[] {
  const includeTools = options.includeTools ?? true;
  const limit = options.toolResultLimit ?? DEFAULT_TOOL_RESULT_LIMIT;
  const out: ExportSection[] = [];
  // tool_use id → tool name, so a result can say which call it answers.
  const toolNames = new Map<string, string>();

  for (const entry of entries) {
    for (const t of entry.toolUses ?? []) if (t.id) toolNames.set(t.id, t.name);
    const role = entry.role;
    if (role !== "user" && role !== "assistant" && role !== "tool_result") continue;
    if (role === "tool_result" && !includeTools) continue;

    let text = (entry.text ?? "").trim();
    const tools = includeTools ? (entry.toolUses ?? []).map((t) => t.name) : [];
    if (!text && tools.length === 0) continue;

    let truncated = 0;
    if (role === "tool_result" && text.length > limit) {
      truncated = text.length - limit;
      text = text.slice(0, limit);
    }

    const sidechain = entry.isSidechain === true;
    const prev = out[out.length - 1];
    if (role === "assistant" && prev?.role === "assistant" && prev.sidechain === sidechain) {
      prev.text = [prev.text, text].filter(Boolean).join("\n\n");
      prev.tools.push(...tools);
      continue;
    }

    out.push({
      role,
      timestamp: entry.timestamp,
      text,
      tools,
      tool: entry.toolUseId ? toolNames.get(entry.toolUseId) : undefined,
      isError: entry.isError === true,
      sidechain,
      truncated,
    });
  }
  return out;
}

/** "2026-10-16 16:47:34 UTC" — fixed-zone, so an export reads the same anywhere. */
export function exportTimestamp(iso: string | undefined): string | undefined {
  if (!iso) return undefined;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return undefined;
  return `${d.toISOString().slice(0, 19).replace("T", " ")} UTC`;
}

/** The last path segment of a cwd — the name the webui shows for a project. */
function projectOf(cwd: string | undefined): string | undefined {
  if (!cwd) return undefined;
  const parts = cwd.replace(/\/+$/, "").split("/");
  return parts[parts.length - 1] || cwd;
}

/** `project-1a2b3c4d`, safe as a file name on any OS. */
export function sessionExportBasename(meta: SessionExportMeta): string {
  const project = (projectOf(meta.cwd) ?? "session").replace(/[^A-Za-z0-9._-]+/g, "_");
  return `${project}-${meta.sessionId.slice(0, 8)}`;
}

function sectionHeading(s: ExportSection): string {
  let h = s.role === "tool_result" && s.tool ? `${s.tool} result` : HEADINGS[s.role];
  if (s.role === "tool_result" && s.isError) h += " (error)";
  if (s.sidechain) h += " · subagent";
  return h;
}

/** Facts for the header, as ordered label/value pairs; absent facts are left out. */
function metaFields(meta: SessionExportMeta): [string, string][] {
  const fields: [string, string | undefined][] = [
    ["session", meta.sessionId],
    ["project", meta.cwd],
    ["model", meta.model],
    ["status", meta.status],
    ["host", meta.hostname],
    ["started", exportTimestamp(meta.startTimestamp)],
    // Only an ended session has an end; for any other the time is its latest write.
    [
      !meta.status || meta.status === "ended" ? "ended" : "last_write",
      exportTimestamp(meta.endTimestamp),
    ],
    ["tokens", meta.totalTokens !== undefined ? String(meta.totalTokens) : undefined],
  ];
  return fields.filter((f): f is [string, string] => f[1] !== undefined && f[1] !== "");
}

/** A code fence longer than any backtick run inside `text`, so it can't close early. */
function fence(text: string): string {
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
  return "`".repeat(Math.max(3, longest + 1));
}

/** The whole session as a Markdown document with a YAML front-matter header. */
export function sessionToMarkdown(
  meta: SessionExportMeta,
  entries: readonly ExportEntry[],
  options: SessionExportOptions = {},
): string {
  const lines: string[] = ["---"];
  // JSON strings are valid YAML scalars, and survive any colon or quote in a path.
  // The token count stays a bare number so front-matter readers type it as one.
  for (const [k, v] of metaFields(meta)) {
    lines.push(`${k}: ${k === "tokens" ? v : JSON.stringify(v)}`);
  }
  lines.push("---", "", `# ${projectOf(meta.cwd) ?? "Session"} — ${meta.sessionId.slice(0, 8)}`);

  for (const s of sessionExportSections(entries, options)) {
    const when = exportTimestamp(s.timestamp);
    lines.push("", `## ${sectionHeading(s)}${when ? ` · ${when}` : ""}`, "");
    if (s.role === "tool_result") {
      const f = fence(s.text);
      lines.push("<details>", "<summary>Output</summary>", "", f, s.text, f);
      if (s.truncated) lines.push("", `_…${s.truncated} more characters truncated._`);
      lines.push("", "</details>");
      continue;
    }
    if (s.text) lines.push(s.text);
    if (s.tools.length) {
      if (s.text) lines.push("");
      lines.push(`_Tools: ${s.tools.map((t) => `\`${t}\``).join(", ")}_`);
    }
  }
  return `${lines.join("\n")}\n`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const PRINT_CSS = `
  @page { margin: 16mm 14mm; }
  body { font: 11pt/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; color: #111; margin: 0; }
  h1 { font-size: 16pt; margin: 0 0 6pt; }
  dl.meta { display: grid; grid-template-columns: max-content 1fr; gap: 1pt 10pt; font-size: 9pt; margin: 0 0 14pt; padding-bottom: 8pt; border-bottom: 1px solid #ccc; }
  dl.meta dt { color: #666; text-transform: uppercase; letter-spacing: .04em; }
  dl.meta dd { margin: 0; font-family: ui-monospace, Menlo, Consolas, monospace; word-break: break-all; }
  section { margin: 0 0 10pt; }
  h2 { font-size: 10pt; margin: 0 0 3pt; break-after: avoid-page; }
  h2 .when { font-weight: normal; color: #777; }
  section.user h2 { color: #1a56a8; }
  section.assistant h2 { color: #8a4b0f; }
  section.tool_result h2 { color: #555; }
  section.error h2 { color: #b00020; }
  section.sidechain { margin-left: 12pt; }
  .text { white-space: pre-wrap; overflow-wrap: anywhere; }
  .tools { color: #666; font-size: 9pt; margin-top: 2pt; }
  pre { white-space: pre-wrap; overflow-wrap: anywhere; font: 8pt/1.35 ui-monospace, Menlo, Consolas, monospace; background: #f5f5f5; padding: 4pt 6pt; margin: 0; }
  .cut { color: #777; font-size: 8pt; font-style: italic; }
`;

/**
 * The whole session as a print-ready HTML document. Text is shown as written (no
 * Markdown rendering — that would need a parser, and plain text prints faithfully).
 */
export function sessionToHtml(
  meta: SessionExportMeta,
  entries: readonly ExportEntry[],
  options: SessionExportOptions = {},
): string {
  const title = `${projectOf(meta.cwd) ?? "Session"} — ${meta.sessionId.slice(0, 8)}`;
  const body: string[] = [`<h1>${escapeHtml(title)}</h1>`, `<dl class="meta">`];
  for (const [k, v] of metaFields(meta)) {
    body.push(`<dt>${escapeHtml(k.replace("_", " "))}</dt><dd>${escapeHtml(v)}</dd>`);
  }
  body.push("</dl>");

  for (const s of sessionExportSections(entries, options)) {
    const classes = [s.role, s.isError ? "error" : "", s.sidechain ? "sidechain" : ""]
      .filter(Boolean)
      .join(" ");
    const when = exportTimestamp(s.timestamp);
    body.push(
      `<section class="${classes}">`,
      `<h2>${escapeHtml(sectionHeading(s))}${when ? ` <span class="when">· ${escapeHtml(when)}</span>` : ""}</h2>`,
    );
    if (s.role === "tool_result") {
      body.push(`<pre>${escapeHtml(s.text)}</pre>`);
      if (s.truncated)
        body.push(`<div class="cut">…${s.truncated} more characters truncated.</div>`);
    } else {
      if (s.text) body.push(`<div class="text">${escapeHtml(s.text)}</div>`);
      if (s.tools.length)
        body.push(`<div class="tools">Tools: ${escapeHtml(s.tools.join(", "))}</div>`);
    }
    body.push("</section>");
  }

  return [
    "<!doctype html>",
    `<html lang="en"><head><meta charset="utf-8">`,
    // The title is what the browser offers as the PDF's file name.
    `<title>${escapeHtml(sessionExportBasename(meta))}</title>`,
    `<style>${PRINT_CSS}</style>`,
    "</head><body>",
    ...body,
    "</body></html>",
  ].join("\n");
}

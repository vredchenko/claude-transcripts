/**
 * Interpret a raw Claude Code transcript JSONL entry (as returned by
 * GET /sessions/{id}/transcript) into a compact, display-friendly shape. The
 * webapi passes entries through verbatim, so this is best-effort and defensive:
 * unknown shapes still render (as raw JSON) rather than throwing.
 */

export interface EntryView {
  /** high-level kind: user / assistant / system / summary / tool / unknown */
  kind: string;
  /** short preview of the textual content, if any */
  preview: string;
  /** true when this entry belongs to a subagent sub-transcript */
  sidechain: boolean;
  /** true when this entry carries an error (tool_result is_error) */
  isError: boolean;
}

type Json = Record<string, unknown>;

function asRecord(v: unknown): Json | undefined {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : undefined;
}

/** Collapse a message `content` (string or content-block array) to plain text. */
function contentToText(content: unknown): { text: string; isError: boolean } {
  if (typeof content === "string") return { text: content, isError: false };
  if (!Array.isArray(content)) return { text: "", isError: false };
  const parts: string[] = [];
  let isError = false;
  for (const raw of content) {
    const block = asRecord(raw);
    if (!block) continue;
    const type = String(block.type ?? "");
    if (type === "text" && typeof block.text === "string") {
      parts.push(block.text);
    } else if (type === "tool_use") {
      parts.push(`⚙ ${String(block.name ?? "tool")}`);
    } else if (type === "tool_result") {
      if (block.is_error === true) isError = true;
      const c = block.content;
      if (typeof c === "string") parts.push(c);
      else parts.push("[tool result]");
    } else if (type === "thinking") {
      parts.push("[thinking]");
    }
  }
  return { text: parts.join(" ").trim(), isError };
}

/** One-line, length-capped preview. */
function clip(text: string, max = 240): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

export function summarizeEntry(entry: Record<string, unknown>): EntryView {
  const type = String(entry.type ?? "");
  const message = asRecord(entry.message);
  const role = message ? String(message.role ?? "") : "";
  const sidechain = entry.isSidechain === true;

  let kind = type || role || "unknown";
  if (type === "user" || role === "user") kind = "user";
  else if (type === "assistant" || role === "assistant") kind = "assistant";
  else if (type === "system") kind = "system";
  else if (type === "summary") kind = "summary";

  let preview = "";
  let isError = false;
  if (message && "content" in message) {
    const c = contentToText(message.content);
    preview = c.text;
    isError = c.isError;
  } else if (typeof entry.summary === "string") {
    preview = entry.summary;
  } else if (typeof entry.content === "string") {
    preview = entry.content;
  }

  return { kind, preview: clip(preview), sidechain, isError };
}

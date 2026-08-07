/**
 * Interpret a transcript turn (as returned by GET /sessions/{id}/transcript) into a
 * compact, display-friendly shape.
 *
 * The webapi normalises both of its sources — CouchDB `chunk` docs and the S3 blob —
 * to the same pruned per-turn shape, so this reads structured fields rather than
 * digging through raw Claude Code JSONL. Still defensive: a turn with no text renders
 * from its tool calls, and an unknown role passes through as-is.
 */
import type { TranscriptEntry } from "./api/generated";

export interface EntryView {
  /**
   * What to label the row: a conversation role (user / assistant / tool_result), or —
   * for the lines that aren't turns — the entry's own kind, e.g.
   * `attachment:hook_success`, `file-history-snapshot`.
   */
  kind: string;
  /** short preview of the textual content, if any */
  preview: string;
  /** true when this entry belongs to a subagent sub-transcript */
  sidechain: boolean;
  /** true when this entry carries an error (a failed tool result) */
  isError: boolean;
}

/** One-line, length-capped preview. */
function clip(text: string, max = 240): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

export function summarizeEntry(entry: TranscriptEntry): EntryView {
  // A turn is often either prose or tool calls; when it has both, show the text and
  // append the calls so an assistant turn never previews as empty.
  const tools = (entry.toolUses ?? []).map((t) => `⚙ ${t.name}`).join(" ");
  const text = entry.text ?? "";
  return {
    // `role` is only ever "other"/"system" for lines that aren't conversation turns,
    // and that label says nothing. `kind` carries what the line actually was, so show
    // that instead — it's the difference between a screen of "other" rows and a
    // readable transcript. Older entries have no `kind`; they fall back to the role.
    kind: entry.kind || entry.role || "other",
    preview: clip(text && tools ? `${text} ${tools}` : text || tools),
    sidechain: entry.isSidechain === true,
    isError: entry.isError === true,
  };
}

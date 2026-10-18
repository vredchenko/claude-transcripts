/**
 * Session export from the browser: pull the whole transcript, then hand it to the
 * shared formatters — as a `.md` download, or as a print-ready document the browser's
 * "Save as PDF" turns into a PDF.
 *
 * The transcript view can't be printed as it stands: it pages lazily and clips each
 * entry to a one-line preview. So export reads every entry itself and prints a
 * document built for paper.
 */
import {
  type ExportEntry,
  type SessionExportMeta,
  type SessionExportOptions,
  sessionExportBasename,
  sessionToHtml,
  sessionToMarkdown,
} from "@claude-transcripts/shared";
import { getSessionTranscript, type SessionSummary, type TranscriptEntry } from "./api/generated";
import { statusTime } from "./format";

/** Entries per request. Large, since the whole transcript is wanted anyway. */
const EXPORT_PAGE_SIZE = 1000;

type FetchPage = typeof getSessionTranscript;

/**
 * Every entry of a session's transcript, in order. Stops at an empty page as well as
 * at `totalCount`, so a live session that grows mid-read can't keep it looping.
 */
export async function fetchFullTranscript(
  sessionId: string,
  fetchPage: FetchPage = getSessionTranscript,
): Promise<TranscriptEntry[]> {
  const entries: TranscriptEntry[] = [];
  for (;;) {
    const page = await fetchPage(sessionId, { offset: entries.length, limit: EXPORT_PAGE_SIZE });
    entries.push(...page.entries);
    if (page.entries.length === 0 || entries.length >= page.totalCount) return entries;
  }
}

/** The header facts an export prints, from the session's summary. */
export function exportMeta(session: SessionSummary): SessionExportMeta {
  return {
    sessionId: session.sessionId,
    cwd: session.cwd,
    model: session.model,
    hostname: session.hostname,
    status: session.status,
    startTimestamp: session.startTimestamp ?? session.timestamp,
    endTimestamp: statusTime(session)?.iso,
    totalTokens: session.tokenUsage?.total,
  };
}

/** Save `markdown` as `<project>-<id8>.md`. */
export function downloadMarkdown(
  meta: SessionExportMeta,
  entries: readonly ExportEntry[],
  options: SessionExportOptions,
): void {
  const blob = new Blob([sessionToMarkdown(meta, entries, options)], {
    type: "text/markdown;charset=utf-8",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${sessionExportBasename(meta)}.md`;
  a.click();
  // Revoking straight away can cancel the download in some browsers; give it a beat.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * Open the print dialog on a print-ready rendering of the session. A hidden iframe
 * rather than a new window: the fetch before it means the click's user activation is
 * gone, and popup blockers would eat `window.open`.
 */
export function printSession(
  meta: SessionExportMeta,
  entries: readonly ExportEntry[],
  options: SessionExportOptions,
): void {
  const frame = document.createElement("iframe");
  frame.setAttribute("aria-hidden", "true");
  frame.style.cssText = "position:fixed;right:0;bottom:0;width:0;height:0;border:0;";
  frame.srcdoc = sessionToHtml(meta, entries, options);
  frame.onload = () => {
    const win = frame.contentWindow;
    if (!win) return frame.remove();
    win.addEventListener("afterprint", () => frame.remove());
    win.focus();
    win.print();
  };
  document.body.appendChild(frame);
}

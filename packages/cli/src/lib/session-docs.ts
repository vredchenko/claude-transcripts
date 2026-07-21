/**
 * Build the CouchDB docs an ingest writes, in **schema parity with the hook**
 * (docs/couchdb-documents.md / couchdb.md). For now these shapes live here; once
 * the hook's write path lands they should be promoted to a shared
 * `@claude-transcripts/shared` doc-schema module (with zod validators) so the hook, the
 * webapi, and the CLI share one definition. TODO(#6): promote + validate.
 */
import { chunkDocId, sliceIntoChunks } from "@claude-transcripts/shared";
import { parseEntries, type SessionFacts } from "./transcript";

/** Provenance of an ingested doc — distinguishes adopted history (`backfill`) and
 *  the `doctor` smoke-test's synthetic session from live logging (the hook writes
 *  `"live"`). */
export type IngestSource = "backfill" | "doctor";

/** A `summary:<id>` doc — the session rollup the hook writes at SessionEnd. */
export interface SummaryDoc {
  _id: string;
  type: "summary";
  event: "SessionEnd";
  session_id: string;
  timestamp: string;
  hostname: string;
  cwd: string;
  model?: string;
  end_reason: string;
  event_count: number;
  prompt_count: number;
  error_count: number;
  tool_counts: Record<string, number>;
  transcript_bytes: number;
  token_usage: SessionFacts["tokenUsage"];
  source: IngestSource;
  /** when the backfill ran (provenance) — distinct from `timestamp`, which is the
   *  session's real end time, so history never reads as created-at-backfill. */
  backfilled_at?: string;
  /** optional attribution (backfill --host/--actor) */
  actor?: string;
}

export function buildSummaryDoc(
  facts: SessionFacts,
  source: IngestSource,
  opts: { actor?: string; backfilledAt?: string } = {},
): SummaryDoc {
  return {
    _id: `summary:${facts.sessionId}`,
    type: "summary",
    event: "SessionEnd",
    session_id: facts.sessionId,
    // No live SessionEnd fired for adopted sessions — use the last transcript ts,
    // so the record reflects the real session time, not the backfill time.
    timestamp: facts.endTimestamp ?? facts.startTimestamp ?? "",
    hostname: facts.hostname,
    cwd: facts.cwd,
    model: facts.model,
    end_reason: "unknown", // not captured in the transcript
    event_count: facts.eventCount,
    prompt_count: facts.promptCount,
    error_count: facts.errorCount,
    tool_counts: facts.toolCounts,
    transcript_bytes: facts.transcriptBytes,
    token_usage: facts.tokenUsage,
    source,
    ...(opts.backfilledAt ? { backfilled_at: opts.backfilledAt } : {}),
    ...(opts.actor ? { actor: opts.actor } : {}),
  };
}

/** A `chunk:<id>:<byte_start>` doc — a byte-faithful slice of the transcript. */
export interface ChunkDoc {
  _id: string;
  type: "chunk";
  session_id: string;
  byte_start: number;
  byte_end: number;
  entry_count: number;
  timestamp: string;
  hostname: string;
  cwd: string;
  schema_version: number;
  source: IngestSource;
}

/**
 * Reconstruct `chunk` docs from a transcript (backfill), so an adopted session is
 * stored like a live one (chunk views reassemble it by byte order). Uses the shared
 * `sliceIntoChunks` policy. Metadata-only: the full content stays in the S3
 * transcript. Chunk `timestamp` is the session start — chunks power reassembly, not
 * the activity timeline (which uses event docs' real per-event times).
 */
export function buildChunkDocs(
  jsonl: string,
  facts: SessionFacts,
  source: IngestSource,
  maxEntriesPerChunk?: number,
): ChunkDoc[] {
  return sliceIntoChunks(jsonl, maxEntriesPerChunk).map((s) => ({
    _id: chunkDocId(facts.sessionId, s.byteStart),
    type: "chunk",
    session_id: facts.sessionId,
    byte_start: s.byteStart,
    byte_end: s.byteEnd,
    entry_count: s.entryCount,
    timestamp: facts.startTimestamp ?? "",
    hostname: facts.hostname,
    cwd: facts.cwd,
    schema_version: 1,
    source,
  }));
}

/** A per-event marker doc — what the live hook appends per hook event. */
export interface EventDoc {
  type: "event";
  event: string;
  session_id: string;
  timestamp: string;
  hostname: string;
  cwd: string;
  [k: string]: unknown;
}

/** Marker previews are short by design — full content lives in chunks/S3. */
const PREVIEW_LIMIT = 200;
const clip = (s: string): string => (s.length > PREVIEW_LIMIT ? s.slice(0, PREVIEW_LIMIT) : s);

/**
 * Reconstruct per-event marker docs from a transcript (backfill). This lifts an
 * adopted session from "summary only" to parity — so the events/tools/activity/
 * failure views populate. The transcript has no hook events, so we reconstruct
 * their equivalents and mark them `reconstructed: true` (distinguishable from live
 * markers). Field shapes mirror the hook's markers (docs/couchdb-documents.md).
 *
 * Emits: `SessionStart`, `UserPromptSubmit`, and one `PostToolUse` /
 * `PostToolUseFailure` per tool call (classified by the matching tool_result's
 * `is_error`).
 *
 * TODO(backfill #6/#7): `SubagentStart`/`SubagentStop` markers from `isSidechain`
 * groups + Task/Agent tool calls (agent_id/agent_type) — sidechain grouping is
 * non-trivial; `facts.hasSidechains` flags their presence. Not emitted yet.
 */
export function buildEventDocs(
  jsonl: string,
  facts: SessionFacts,
  source: IngestSource,
): EventDoc[] {
  const entries = parseEntries(jsonl);
  const docs: EventDoc[] = [];
  const mk = (
    event: string,
    timestamp: string | undefined,
    extra: Record<string, unknown> = {},
  ): EventDoc => ({
    type: "event",
    event,
    session_id: facts.sessionId,
    timestamp: timestamp ?? facts.startTimestamp ?? "",
    hostname: facts.hostname,
    cwd: facts.cwd,
    reconstructed: true,
    ingest_source: source,
    ...extra,
  });

  // Index tool_result by tool_use_id, to classify each tool_use success/failure.
  const results = new Map<string, { isError: boolean; text: string }>();
  for (const e of entries) {
    const content = e.message?.content;
    if (!Array.isArray(content)) continue;
    for (const item of content) {
      if (item?.type === "tool_result" && typeof item.tool_use_id === "string") {
        results.set(item.tool_use_id, {
          isError: item.is_error === true,
          text: blockText(item.content),
        });
      }
    }
  }

  // SessionStart — CC `source`/`permission_mode` aren't in the transcript.
  docs.push(mk("SessionStart", facts.startTimestamp, facts.model ? { model: facts.model } : {}));

  for (const e of entries) {
    const content = e.message?.content;
    if (e.type === "user" && e.isSidechain !== true) {
      const text = blockText(content, "text");
      if (text.trim()) {
        docs.push(
          mk("UserPromptSubmit", e.timestamp, {
            prompt_length: text.length,
            prompt_preview: clip(text),
          }),
        );
      }
    }
    if (e.type === "assistant" && Array.isArray(content)) {
      for (const item of content) {
        if (item?.type !== "tool_use" || typeof item.name !== "string") continue;
        const id = typeof item.id === "string" ? item.id : undefined;
        const result = id ? results.get(id) : undefined;
        if (result?.isError) {
          docs.push(
            mk("PostToolUseFailure", e.timestamp, {
              tool_name: item.name,
              tool_use_id: id,
              error_preview: clip(result.text),
              is_interrupt: /interrupted by the user/i.test(result.text),
            }),
          );
        } else {
          docs.push(
            mk("PostToolUse", e.timestamp, {
              tool_name: item.name,
              tool_use_id: id,
              input_preview: clip(safeStringify(item.input)),
            }),
          );
        }
      }
    }
  }

  return docs;
}

/** Flatten a message/tool_result content field to text. `onlyType` filters items. */
function blockText(content: unknown, onlyType?: string): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return (
      content
        // biome-ignore lint/suspicious/noExplicitAny: upstream content items
        .filter((c: any) => (onlyType ? c?.type === onlyType : true))
        // biome-ignore lint/suspicious/noExplicitAny: upstream content items
        .map((c: any) => (typeof c?.text === "string" ? c.text : ""))
        .join("")
    );
  }
  return "";
}

function safeStringify(v: unknown): string {
  try {
    return JSON.stringify(v) ?? "";
  } catch {
    return "";
  }
}

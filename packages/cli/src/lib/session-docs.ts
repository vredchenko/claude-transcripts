/**
 * Build the CouchDB docs an ingest writes, in **schema parity with the hook**
 * (docs/reference/couchdb.md). The doc shapes are the shared schemas'
 * (`@claude-transcripts/shared/docs`) — the ones `/api/ingest/*` validates against —
 * narrowed here only where this writer is stricter than the gateway.
 */
import {
  buildChunkEntries,
  type ChunkEntry,
  chunkDocId,
  sliceIntoChunks,
  sumTranscriptTokens,
} from "@claude-transcripts/shared";
import type {
  ChunkDoc as ChunkDocShape,
  EventDoc as EventDocShape,
  SummaryDoc as SummaryDocShape,
} from "@claude-transcripts/shared/docs";
import type { SessionSummary } from "../api/generated";
import { isUserPrompt, parseEntries, type SessionFacts } from "./transcript";

/** Provenance of an ingested doc — distinguishes adopted history (`backfill`) and
 *  the `doctor` smoke-test's synthetic session from live logging (the hook writes
 *  `"live"`). */
export type IngestSource = "backfill" | "doctor" | "reconcile";

/** A `summary:<id>` doc — the session rollup the hook writes at SessionEnd. */
export type SummaryDoc = SummaryDocShape & {
  /** Always set by this writer (the schema leaves it open). */
  source: IngestSource;
  /** when `reconcile` finalised it — `timestamp` stays the session's last activity. */
  reconciled_at?: string;
};

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

/**
 * The summary a session would have had, for one that never fired `SessionEnd`.
 *
 * Built from what was recorded rather than from the transcript: the counts are the
 * event aggregate the gateway already serves for a summary-less session — the same
 * markers the hook's own counters would have totalled — so finalising a session does
 * not move its numbers. The S3 transcript, when one exists, adds what only it holds:
 * token usage and the exact byte count. Without it there are no token figures, so
 * `token_usage` is left out rather than written as zeros.
 *
 * `end_reason` is `unknown` (nothing recorded why it stopped) and `timestamp` is the
 * last activity, so the session reads as ending when it went quiet, not when it was
 * reconciled; `source: "reconcile"` + `reconciled_at` say how and when.
 */
export function buildReconciledSummary(
  s: SessionSummary,
  transcript: string | null,
  reconciledAt: string,
): SummaryDoc {
  return {
    _id: `summary:${s.sessionId}`,
    type: "summary",
    event: "SessionEnd",
    session_id: s.sessionId,
    timestamp: s.lastActivity || s.timestamp,
    hostname: s.hostname,
    cwd: s.cwd,
    ...(s.model ? { model: s.model } : {}),
    end_reason: "unknown",
    event_count: s.eventCount,
    prompt_count: s.promptCount,
    error_count: s.errorCount,
    tool_counts: s.toolCounts,
    transcript_bytes: transcript ? Buffer.byteLength(transcript) : (s.transcriptSize ?? 0),
    ...(transcript ? { token_usage: sumTranscriptTokens(transcript) } : {}),
    source: "reconcile",
    reconciled_at: reconciledAt,
  };
}

/** A `chunk:<id>:<byte_start>` doc — a byte-faithful slice of the transcript. */
export type ChunkDoc = ChunkDocShape & {
  source: IngestSource;
  /** Parsed per-turn content (ADR 0027) — present only for full-content chunks. */
  entries?: ChunkEntry[];
};

/**
 * Reconstruct `chunk` docs from a transcript (backfill), so an adopted session is
 * stored like a live one (chunk views reassemble it by byte order). Uses the shared
 * `sliceIntoChunks` policy. Chunk `timestamp` is the session start — chunks power
 * reassembly, not the activity timeline (which uses event docs' real per-event times).
 *
 * With `withContent` (default), each chunk also embeds its parsed `entries[]`
 * (ADR 0027) — the byte-identical partition the live hook writes; pass `false` for
 * byte-range-only chunks (content then lives in the S3 transcript alone).
 */
export function buildChunkDocs(
  jsonl: string,
  facts: SessionFacts,
  source: IngestSource,
  maxEntriesPerChunk?: number,
  withContent = true,
): ChunkDoc[] {
  const slices = sliceIntoChunks(jsonl, maxEntriesPerChunk);
  const allEntries = withContent ? buildChunkEntries(jsonl) : undefined;
  let cursor = 0;
  return slices.map((s) => {
    const entries = allEntries?.slice(cursor, cursor + s.entryCount);
    cursor += s.entryCount;
    return {
      _id: chunkDocId(facts.sessionId, s.byteStart),
      type: "chunk" as const,
      session_id: facts.sessionId,
      byte_start: s.byteStart,
      byte_end: s.byteEnd,
      entry_count: s.entryCount,
      timestamp: facts.startTimestamp ?? "",
      hostname: facts.hostname,
      cwd: facts.cwd,
      schema_version: withContent ? 2 : 1,
      source,
      ...(entries ? { entries } : {}),
    };
  });
}

/** A per-event marker doc — what the live hook appends per hook event. */
export type EventDoc = EventDocShape;

/** Marker previews are short by design — full content lives in chunks/S3. */
const PREVIEW_LIMIT = 200;
const clip = (s: string): string => (s.length > PREVIEW_LIMIT ? s.slice(0, PREVIEW_LIMIT) : s);

/**
 * Reconstruct per-event marker docs from a transcript (backfill). This lifts an
 * adopted session from "summary only" to parity — so the events/tools/activity/
 * failure views populate. The transcript has no hook events, so we reconstruct
 * their equivalents and mark them `reconstructed: true` (distinguishable from live
 * markers). Field shapes mirror the hook's markers (docs/reference/couchdb.md).
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
    if (isUserPrompt(e)) {
      const text = blockText(content, "text");
      docs.push(
        mk("UserPromptSubmit", e.timestamp, {
          prompt_length: text.length,
          prompt_preview: clip(text),
        }),
      );
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
        // `any` throughout: these are upstream-owned content items, not our shape.
        .filter((c: any) => (onlyType ? c?.type === onlyType : true))
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

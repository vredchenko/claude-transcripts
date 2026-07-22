/**
 * Shared package entry. Re-exports the app model (the isomorphic central state)
 * plus the cross-cutting types + token accounting below.
 */

export * from "./migrations";
export * from "./model";

/**
 * Shared types + token accounting for claude-transcripts.
 *
 * The webapi imports these. The Claude Code hook (hooks/) keeps a byte-identical
 * copy of `sumTranscriptTokens` in hooks/scripts/transcript-tokens.ts — it ships
 * as a standalone plugin and can't resolve this workspace at install time, so
 * the two must be kept in sync (same dedupe-by-message-id algorithm).
 */

// ── Token usage ───────────────────────────────────────────────────────────────

export interface TokenUsage {
  input: number;
  output: number;
  cacheCreation: number;
  cacheRead: number;
  total: number;
  messages: number;
}

interface UsageBlock {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

function usageWeight(u: UsageBlock): number {
  return (
    (u.input_tokens || 0) +
    (u.output_tokens || 0) +
    (u.cache_creation_input_tokens || 0) +
    (u.cache_read_input_tokens || 0)
  );
}

/**
 * Sum Anthropic token usage from a Claude Code transcript (JSONL).
 *
 * Token usage lives only inside the transcript (`message.usage` per assistant
 * turn). The same assistant message is logged multiple times (streaming chunks +
 * snapshot updates), so a naive sum overcounts. We dedupe by the Anthropic
 * message id, keeping the heaviest usage seen per id.
 */
export function sumTranscriptTokens(jsonl: string): TokenUsage {
  const byMessage = new Map<string, UsageBlock>();
  let anonSeq = 0;

  for (const line of jsonl.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let doc: any;
    try {
      doc = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const usage: UsageBlock | undefined = doc?.message?.usage;
    if (!usage) continue;
    const id: string = doc.message?.id || `__anon_${anonSeq++}`;
    const prev = byMessage.get(id);
    if (!prev || usageWeight(usage) > usageWeight(prev)) {
      byMessage.set(id, usage);
    }
  }

  const acc: TokenUsage = {
    input: 0,
    output: 0,
    cacheCreation: 0,
    cacheRead: 0,
    total: 0,
    messages: byMessage.size,
  };

  for (const u of byMessage.values()) {
    acc.input += u.input_tokens || 0;
    acc.output += u.output_tokens || 0;
    acc.cacheCreation += u.cache_creation_input_tokens || 0;
    acc.cacheRead += u.cache_read_input_tokens || 0;
  }
  acc.total = acc.input + acc.output + acc.cacheCreation + acc.cacheRead;

  return acc;
}

// ── Session shapes (webapi response contract, consumed by the webui + cli) ─────

export type SessionStatus = "ended" | "running" | "incomplete";

export interface SessionSummary {
  sessionId: string;
  timestamp: string;
  startTimestamp?: string;
  /** Wall-clock runtime: last activity minus first event (includes idle time). */
  durationMs?: number;
  /**
   * Active time: `durationMs` minus idle gaps — the sum of inter-event intervals
   * that fall within the idle threshold. Distinguishes real working time from a
   * session left open (e.g. in tmux). Derived on the session detail from per-event
   * timestamps; see `sumActiveDurationMs`.
   */
  activeMs?: number;
  model?: string;
  cwd: string;
  hostname: string;
  eventCount: number;
  promptCount: number;
  errorCount: number;
  toolCounts: Record<string, number>;
  endReason: string;
  hasTranscript: boolean;
  transcriptSize?: number;
  status: SessionStatus;
  lastActivity?: string;
  tokenUsage?: TokenUsage;
  /**
   * Provenance of the recording: "live" (streamed by the hook as it happened) vs
   * "backfill" / "doctor" / … (adopted after the fact). Undefined ⇒ unknown (treat
   * as live). A session still in progress has no summary doc yet, so it's live.
   */
  source?: string;
}

export interface SessionsResponse {
  sessions: SessionSummary[];
  totalCount: number;
}

export interface TranscriptResponse {
  messages: Record<string, any>[];
  totalCount: number;
  hasMore: boolean;
}

/** Default idle threshold (ms): gaps longer than this count as idle, not activity. */
export const DEFAULT_IDLE_THRESHOLD_MS = 5 * 60 * 1000; // 5 min

/**
 * Active session time: the wall-clock span minus idle gaps. Given event timestamps
 * (ISO strings, any order), sort them and sum the intervals between consecutive
 * events, counting a gap only if it is within `idleThresholdMs` — longer gaps mean
 * the session sat idle (e.g. left running in tmux) and are excluded. Returns 0 for
 * fewer than two valid timestamps. Pure + isomorphic (webapi and hook can share it).
 */
export function sumActiveDurationMs(
  timestamps: string[],
  idleThresholdMs: number = DEFAULT_IDLE_THRESHOLD_MS,
): number {
  const ms = timestamps
    .map((t) => Date.parse(t))
    .filter((n) => !Number.isNaN(n))
    .sort((a, b) => a - b);
  let active = 0;
  let prev: number | undefined;
  for (const t of ms) {
    if (prev !== undefined) {
      const gap = t - prev;
      if (gap > 0 && gap <= idleThresholdMs) active += gap;
    }
    prev = t;
  }
  return active;
}

// ── Transcript chunking ─────────────────────────────────────────────────────────
//
// Shared with the hook's flush-transcript-chunk (the hook keeps a byte-identical
// copy, like sumTranscriptTokens, since it can't resolve the workspace). Used by
// `backfill` to reconstruct `chunk` docs matching how a live session is stored.

/** Default chunk size (entries per chunk); mirrors config.system.logging.chunk. */
export const DEFAULT_MAX_ENTRIES_PER_CHUNK = 200;

/** A byte-faithful slice of a transcript — the basis for a `chunk:<id>:<byte_start>` doc. */
export interface ChunkSlice {
  byteStart: number;
  byteEnd: number;
  entryCount: number;
}

/**
 * Slice a JSONL transcript into byte-faithful chunks of up to `maxEntriesPerChunk`
 * non-empty entries. Pure + deterministic — the same size policy the live chunker
 * uses, so a backfilled session's chunks are structurally identical to live ones
 * (boundaries differ only where live would additionally time-flush). Offsets are
 * UTF-8 byte offsets; consecutive slices tile the whole transcript with no gaps.
 */
export function sliceIntoChunks(
  jsonl: string,
  maxEntriesPerChunk: number = DEFAULT_MAX_ENTRIES_PER_CHUNK,
): ChunkSlice[] {
  const max = Math.max(1, maxEntriesPerChunk);
  const enc = new TextEncoder();
  const lines = jsonl.split("\n");
  // Byte offset where each line begins; offsets[lines.length] = total byte length.
  const offsets = new Array<number>(lines.length + 1);
  offsets[0] = 0;
  for (let i = 0; i < lines.length; i++) {
    const newline = i < lines.length - 1 ? 1 : 0; // split() implies a \n between lines
    offsets[i + 1] = offsets[i]! + enc.encode(lines[i]).length + newline;
  }
  const slices: ChunkSlice[] = [];
  let startLine = 0;
  let entryCount = 0;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]!.trim().length > 0) entryCount++;
    if (entryCount >= max || (i === lines.length - 1 && entryCount > 0)) {
      slices.push({ byteStart: offsets[startLine]!, byteEnd: offsets[i + 1]!, entryCount });
      startLine = i + 1;
      entryCount = 0;
    }
  }
  return slices;
}

/** Stable chunk-doc id `chunk:<sessionId>:<byteStart padded to 12>` (sorts by byte order). */
export function chunkDocId(sessionId: string, byteStart: number): string {
  return `chunk:${sessionId}:${String(byteStart).padStart(12, "0")}`;
}

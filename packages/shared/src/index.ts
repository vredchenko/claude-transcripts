/**
 * Shared package entry. Re-exports the app model (the isomorphic central state)
 * plus the cross-cutting types + token accounting below.
 */

export * from "./couch-url";
export * from "./migrations";
export * from "./model";

/**
 * Shared types + token accounting for claude-transcripts.
 *
 * Imported by the webapi and by the CLI — including the CLI's hook, which is the
 * writer. There is no second copy to keep in step: the plugin under `hooks/` pipes its
 * payload to `claude-transcripts hook run` rather than reimplementing any of this
 * ([ADR 0004](../../../docs/design/decisions/0004-bun-monorepo-hook-as-standalone-plugin.md)).
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

/**
 * `GET /api/sessions/{id}/transcript`. Turns come from the `chunk` docs by default and
 * from the S3 blob only when that reaches further, so a **live** session's
 * transcript-so-far is readable — it doesn't wait for the SessionEnd upload. Both
 * sources normalise to {@link ChunkEntry}, so the shape never depends on `source`.
 */
export interface TranscriptResponse {
  entries: ChunkEntry[];
  totalCount: number;
  hasMore: boolean;
  /** Which store served this page. */
  source: "chunks" | "s3";
  /** Transcript bytes the serving source covers (diagnostics). */
  byteCoverage: number;
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
// Used by the hook's flush-transcript-chunk action and by `backfill`, so an adopted
// session's `chunk` docs partition exactly as a live session's do.

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

// ── Content chunks (per-turn parsed content embedded in chunk docs, ADR 0027) ───
//
// When `couchFullContentChunks` is on, a chunk doc carries the parsed turns it
// covers (`entries[]`) in addition to its byte range — so CouchDB map-reduce views
// can read individual turns (speaker-split, per-turn search) without fetching S3.
// `buildChunkEntries` output partitions 1:1 with `sliceIntoChunks(jsonl)` by
// `entryCount` (one entry per non-blank line, in order), so a writer attaches each
// chunk's entries by slicing.

/** Speaker/kind of a parsed transcript turn projected into a content chunk. */
export type ChunkEntryRole = "user" | "assistant" | "tool_result" | "system" | "other";

/**
 * One parsed transcript turn inside a content chunk — a pruned projection of a JSONL
 * entry. Ordering is (chunk.byte_start, array position); no global index is stored,
 * so it stays consistent between live flushes and backfill.
 */
export interface ChunkEntry {
  role: ChunkEntryRole;
  timestamp?: string;
  /** Flattened text: assistant/user text blocks, or a tool_result's text. */
  text?: string;
  /** tool_use calls in an assistant turn. */
  toolUses?: { name: string; id?: string }[];
  /** For a tool_result turn: the tool_use id it answers, and whether it errored. */
  toolUseId?: string;
  isError?: boolean;
  /** A subagent sub-transcript line. */
  isSidechain?: boolean;
  /**
   * For a line that isn't a conversation turn: what it actually is.
   *
   * Claude Code's JSONL carries far more than user/assistant messages — attachments,
   * file-history snapshots, queue operations, mode changes, titles. In a real corpus
   * `attachment` alone outnumbers user turns. All of it lands in `role: "other"` (or
   * `"system"`), and without this a reader has a row it can only render blank.
   *
   * The source `type`, refined by the entry's own subtype where it has one:
   * `"attachment:hook_success"`, `"system:turn_duration"`, `"file-history-snapshot"`.
   * Absent on real conversation turns, whose `role` already says everything.
   */
  kind?: string;
}

/** Flatten a message/tool_result content field to text (`onlyType` filters items). */
function flattenEntryText(content: any, onlyType?: string): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  let out = "";
  for (const item of content) {
    if (onlyType && item?.type !== onlyType) continue;
    if (typeof item?.text === "string") out += item.text;
  }
  return out;
}

/** Project one parsed JSONL doc into a pruned `ChunkEntry`. */
function projectChunkEntry(doc: any): ChunkEntry {
  const type: string = typeof doc?.type === "string" ? doc.type : "other";
  const content = doc?.message?.content;
  const timestamp: string | undefined =
    typeof doc?.timestamp === "string" ? doc.timestamp : undefined;
  const sidechain = doc?.isSidechain === true;

  if (type === "assistant") {
    const toolUses: { name: string; id?: string }[] = [];
    if (Array.isArray(content)) {
      for (const item of content) {
        if (item?.type === "tool_use" && typeof item.name === "string") {
          toolUses.push(item.id ? { name: item.name, id: String(item.id) } : { name: item.name });
        }
      }
    }
    const text = flattenEntryText(content, "text");
    const entry: ChunkEntry = { role: "assistant" };
    if (timestamp) entry.timestamp = timestamp;
    if (text) entry.text = text;
    if (toolUses.length) entry.toolUses = toolUses;
    if (sidechain) entry.isSidechain = true;
    return entry;
  }

  if (type === "user") {
    // A user turn is a real prompt unless it carries a tool_result echo.
    const toolResult = Array.isArray(content)
      ? content.find((i: any) => i?.type === "tool_result")
      : undefined;
    if (toolResult) {
      const entry: ChunkEntry = { role: "tool_result" };
      if (timestamp) entry.timestamp = timestamp;
      const text = flattenEntryText(toolResult.content);
      if (text) entry.text = text;
      if (typeof toolResult.tool_use_id === "string") entry.toolUseId = toolResult.tool_use_id;
      if (toolResult.is_error === true) entry.isError = true;
      if (sidechain) entry.isSidechain = true;
      return entry;
    }
    const entry: ChunkEntry = { role: "user" };
    if (timestamp) entry.timestamp = timestamp;
    const text = flattenEntryText(content, "text");
    if (text) entry.text = text;
    if (sidechain) entry.isSidechain = true;
    return entry;
  }

  // Everything that isn't a conversation turn. Keep the coarse role (so existing
  // readers and the speaker-split views are unaffected) but say what the line was,
  // and give it a one-line summary — otherwise it renders as an empty row, which is
  // what a large fraction of a real transcript used to look like.
  const entry: ChunkEntry = { role: type === "system" ? "system" : "other" };
  if (timestamp) entry.timestamp = timestamp;
  const text = flattenEntryText(content, "text") || summariseNonMessage(doc, type);
  if (text) entry.text = text;
  entry.kind = nonMessageKind(doc, type);
  if (sidechain) entry.isSidechain = true;
  return entry;
}

/** `<type>` refined by the entry's own subtype, e.g. `attachment:hook_success`. */
function nonMessageKind(doc: any, type: string): string {
  if (type === "attachment") {
    const sub = doc?.attachment?.type;
    return typeof sub === "string" && sub ? `attachment:${sub}` : "attachment";
  }
  if (type === "system") {
    const sub = doc?.subtype;
    return typeof sub === "string" && sub ? `system:${sub}` : "system";
  }
  return type;
}

/**
 * A short, human-readable summary of a non-conversation line.
 *
 * Deliberately shallow: read the one obvious field each entry type carries and stop.
 * These lines are context, not content — enough to see what happened when scrolling a
 * transcript, not a second rendering of the session.
 */
function summariseNonMessage(doc: any, type: string): string {
  const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
  switch (type) {
    case "last-prompt":
      return str(doc?.lastPrompt);
    case "ai-title":
      return str(doc?.aiTitle);
    case "mode":
      return str(doc?.mode);
    case "permission-mode":
      return str(doc?.permissionMode);
    case "pr-link": {
      const n = typeof doc?.prNumber === "number" ? `#${doc.prNumber}` : "";
      return [n, str(doc?.prUrl)].filter(Boolean).join(" ");
    }
    case "queue-operation":
      return [str(doc?.operation), str(doc?.content)].filter(Boolean).join(": ");
    case "file-history-snapshot":
    case "file-history-delta":
      return str(doc?.trackingPath);
    default:
      return "";
  }
}

/**
 * Parse a JSONL transcript (or slice) into pruned per-turn `ChunkEntry`s — exactly
 * one entry per non-blank line, in order (a malformed line yields an `"other"`
 * placeholder so the count stays aligned with `sliceIntoChunks`). Pure + isomorphic.
 */
export function buildChunkEntries(jsonl: string): ChunkEntry[] {
  const out: ChunkEntry[] = [];
  for (const line of jsonl.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(projectChunkEntry(JSON.parse(trimmed)));
    } catch {
      out.push({ role: "other" }); // keep 1:1 with sliceIntoChunks' entry count
    }
  }
  return out;
}

/** One turn from the speaker-split view (`GET /api/sessions/{id}/turns`, ADR 0027). */
export interface SpeakerTurn {
  role: ChunkEntryRole;
  timestamp: string;
  text: string;
  toolUses?: { name: string; id?: string }[] | null;
  toolUseId?: string | null;
  isError?: boolean;
}

/** Response contract for the speaker-split turns endpoint. */
export interface SessionTurnsResponse {
  turns: SpeakerTurn[];
  totalCount: number;
  hasMore: boolean;
  /** The role filter that produced these turns, or null for "all turns". */
  role: ChunkEntryRole | null;
}

/**
 * A turn from the cross-session view (`GET /api/turns`) — every turn of one speaker
 * across all sessions, in time order. Carries its `sessionId`/`cwd` so a turn read
 * outside its session keeps its project context.
 */
export interface CrossSessionTurn {
  sessionId: string;
  cwd: string;
  role: ChunkEntryRole;
  timestamp: string;
  text: string;
}

/** Response contract for the cross-session turns endpoint. */
export interface CrossSessionTurnsResponse {
  turns: CrossSessionTurn[];
  hasMore: boolean;
  role: ChunkEntryRole | null;
}

/** One full-text search result (a matching session), from `GET /api/search`. */
export interface SearchHit {
  sessionId: string;
  timestamp?: string;
  cwd?: string;
  model?: string;
  hostname?: string;
  endReason?: string;
  source?: string;
  tools?: string[];
}

/** A conversation-content search match — one turn, with a cropped snippet. */
export interface TurnHit {
  sessionId: string;
  role: string;
  snippet: string;
  timestamp?: string;
  cwd?: string;
}

/** Response contract for the search endpoint. */
export interface SearchResponse {
  /** Session-metadata matches. */
  hits: SearchHit[];
  /** Conversation-content matches (content chunks only). */
  turns: TurnHit[];
  query: string;
  /** false when Meilisearch is disabled/unconfigured. */
  enabled: boolean;
}

/**
 * Transcript parser — turns a Claude Code `<id>.jsonl` transcript into typed
 * entries and derived per-session facts. Reused by backfill and (later) as
 * a verification oracle (diff CouchDB content against the fs transcript). Token
 * math reuses the shared `sumTranscriptTokens` — the same dedupe-by-message-id
 * rule the hook uses, so counts match (docs/operate/tools.md "schema parity").
 */
import { sumTranscriptTokens, type TokenUsage } from "@claude-transcripts/shared";

/** One parsed transcript line. Claude Code owns the exact shape; we read loosely. */
export interface TranscriptEntry {
  type: string; // assistant | user | system | file-history-snapshot | …
  sessionId?: string;
  cwd?: string;
  timestamp?: string;
  gitBranch?: string;
  version?: string;
  isSidechain?: boolean; // true ⇒ a subagent sub-transcript line
  // `any`: the message shape is upstream-owned, not ours to pin down.
  message?: any;
  [k: string]: unknown;
}

/** Parse JSONL into entries, skipping blank/malformed lines (never throws). */
export function parseEntries(jsonl: string): TranscriptEntry[] {
  const out: TranscriptEntry[] = [];
  for (const line of jsonl.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed) as TranscriptEntry);
    } catch {
      // tolerate a partially-written / corrupt line
    }
  }
  return out;
}

/** Per-session facts derived from a transcript — the basis for the summary doc. */
export interface SessionFacts {
  sessionId: string;
  cwd: string;
  hostname: string;
  gitBranch?: string;
  ccVersion?: string;
  model?: string;
  startTimestamp?: string;
  endTimestamp?: string;
  /**
   * What the live hook's `event_count` would have reached for this transcript: one per
   * hook payload that runs `update-counts` — `UserPromptSubmit`, `PostToolUse`,
   * `PostToolUseFailure`, `SubagentStart`/`SubagentStop` and `StopFailure`
   * (`SessionStart`, `Stop`, the compaction events and `SessionEnd` are recorded but
   * not counted). From a transcript that is `promptCount` + one per answered tool call.
   * Subagent lifecycle and `StopFailure` leave no reliable trace in the file and are
   * not counted, so a backfilled count can read lower than a live one, never higher.
   */
  eventCount: number;
  /** Prompts the user submitted — what `UserPromptSubmit` fires for (see `isUserPrompt`). */
  promptCount: number;
  /**
   * The `PostToolUseFailure` equivalents: tool results with `is_error: true` (failed,
   * rejected or interrupted tool calls). `StopFailure` is not derivable, so not counted.
   */
  errorCount: number;
  /** Successful (`PostToolUse`) tool calls by tool name — failures are not counted here,
   *  as in the hook's `tool_counts`. */
  toolCounts: Record<string, number>;
  tokenUsage: TokenUsage;
  transcriptBytes: number;
  /** subagent sub-transcripts present (backfill captures these; subagent docs TODO) */
  hasSidechains: boolean;
}

export interface DeriveOpts {
  hostname?: string;
  /** trust the filename's session id over the in-file value (they should match) */
  sessionIdHint?: string;
}

export function deriveSessionFacts(jsonl: string, opts: DeriveOpts = {}): SessionFacts {
  const entries = parseEntries(jsonl);
  const main = entries.filter((e) => e.type === "assistant" || e.type === "user");
  const first = main[0];
  const last = main[main.length - 1];
  const firstAssistant = main.find((e) => e.type === "assistant");

  // A tool call fires a Post* hook only once its result is back, so tool calls are
  // counted by their results: `is_error` ⇒ PostToolUseFailure, otherwise PostToolUse.
  const results = new Map<string, boolean>(); // tool_use_id → is_error
  for (const e of main) {
    const content = e.message?.content;
    if (e.type !== "user" || !Array.isArray(content)) continue;
    for (const item of content) {
      if (item?.type === "tool_result" && typeof item.tool_use_id === "string") {
        results.set(item.tool_use_id, item.is_error === true);
      }
    }
  }

  const toolCounts: Record<string, number> = {};
  const seenToolUses = new Set<string>();
  let promptCount = 0;
  let toolCalls = 0;
  let errorCount = 0;
  for (const e of main) {
    const content = e.message?.content;
    if (e.type === "assistant" && Array.isArray(content)) {
      for (const item of content) {
        if (item?.type !== "tool_use" || typeof item.name !== "string") continue;
        if (typeof item.id !== "string" || seenToolUses.has(item.id)) continue;
        seenToolUses.add(item.id);
        const isError = results.get(item.id);
        if (isError === undefined) continue; // never answered — no Post* hook fired
        toolCalls++;
        if (isError) errorCount++;
        else toolCounts[item.name] = (toolCounts[item.name] ?? 0) + 1;
      }
    }
    if (isUserPrompt(e)) promptCount++;
  }

  return {
    sessionId: opts.sessionIdHint ?? first?.sessionId ?? "unknown",
    cwd: first?.cwd ?? "",
    hostname: opts.hostname ?? "",
    gitBranch: first?.gitBranch,
    ccVersion: first?.version,
    model: firstAssistant?.message?.model,
    startTimestamp: first?.timestamp,
    endTimestamp: last?.timestamp,
    eventCount: promptCount + toolCalls,
    promptCount,
    errorCount,
    toolCounts,
    tokenUsage: sumTranscriptTokens(jsonl),
    transcriptBytes: new TextEncoder().encode(jsonl).length,
    hasSidechains: entries.some((e) => e.isSidechain === true),
  };
}

/**
 * A prompt the user submitted — what fires `UserPromptSubmit`: a main-chain user turn
 * carrying text. Not a tool_result echoed back as a user turn, a subagent's (sidechain)
 * prompt, a line Claude Code injects itself (`isMeta`, the compaction summary), or the
 * "[Request interrupted by user…]" marker it appends on an interrupt.
 */
export function isUserPrompt(e: TranscriptEntry): boolean {
  if (e.type !== "user" || e.isSidechain === true) return false;
  if (e.isMeta === true || e.isCompactSummary === true) return false;
  const text = promptText(e.message?.content).trim();
  return text.length > 0 && !INTERRUPT_MARKER.test(text);
}

const INTERRUPT_MARKER = /^\[Request interrupted by user[^\]]*\]$/;

function promptText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  // `any`: upstream-owned content items.
  return content
    .filter((c: any) => c?.type === "text" && typeof c.text === "string")
    .map((c: any) => c.text)
    .join("");
}

/**
 * Transcript parser — turns a Claude Code `<id>.jsonl` transcript into typed
 * entries and derived per-session facts. Reused by backfill and (later) as
 * a verification oracle (diff CouchDB content against the fs transcript). Token
 * math reuses the shared `sumTranscriptTokens` — the same dedupe-by-message-id
 * rule the hook uses, so counts match (docs/tools.md "schema parity").
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
  // biome-ignore lint/suspicious/noExplicitAny: message shape is upstream-owned
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
  /** assistant+user turns — TODO: align with the hook's event-count semantics */
  eventCount: number;
  promptCount: number;
  /** TODO: count tool_result is_error / PostToolUseFailure-equivalents */
  errorCount: number;
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

  const toolCounts: Record<string, number> = {};
  let promptCount = 0;
  for (const e of main) {
    const content = e.message?.content;
    if (e.type === "assistant" && Array.isArray(content)) {
      for (const item of content) {
        if (item?.type === "tool_use" && typeof item.name === "string") {
          toolCounts[item.name] = (toolCounts[item.name] ?? 0) + 1;
        }
      }
    }
    if (e.type === "user" && e.isSidechain !== true && isRealPrompt(content)) {
      promptCount++;
    }
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
    eventCount: main.length,
    promptCount,
    errorCount: 0,
    toolCounts,
    tokenUsage: sumTranscriptTokens(jsonl),
    transcriptBytes: new TextEncoder().encode(jsonl).length,
    hasSidechains: entries.some((e) => e.isSidechain === true),
  };
}

/** A real user prompt (text), not a tool_result echoed back as a user turn. */
function isRealPrompt(content: unknown): boolean {
  if (typeof content === "string") return content.trim().length > 0;
  if (Array.isArray(content)) {
    // biome-ignore lint/suspicious/noExplicitAny: upstream content items
    return content.some((c: any) => c?.type === "text");
  }
  return false;
}

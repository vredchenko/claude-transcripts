/**
 * Fake-Claude-Code session synthesizer for the end-to-end suite (testing.md).
 *
 * Produces, for a single session, the same artefacts a real recording yields — a
 * transcript JSONL plus the derived `summary` / `event` / `chunk` docs — computed
 * with the *real* shared helpers (`sumTranscriptTokens`, `sliceIntoChunks`,
 * `chunkDocId`) so the expected numbers can't drift from the app's own accounting.
 * The e2e spec POSTs these through the webapi and asserts they read back.
 */
import { chunkDocId, sliceIntoChunks, sumTranscriptTokens } from "@claude-transcripts/shared";

export interface SynthOptions {
  sessionId: string;
  hostname?: string;
  cwd?: string;
  model?: string;
  startedAt?: string;
  /** number of user prompts (each yields a user + an assistant transcript entry) */
  prompts?: number;
  /** successful PostToolUse counts, keyed by tool name */
  tools?: Record<string, number>;
  /** number of PostToolUseFailure events */
  errors?: number;
  /** extra subagent (sidechain) transcript entries — present in the transcript +
   *  chunks + token math, but not in the main prompt/tool/event rollups */
  sidechains?: number;
}

export interface SynthSession {
  sessionId: string;
  transcript: string;
  summaryDoc: Record<string, unknown>;
  eventDocs: Record<string, unknown>[];
  chunkDocs: Record<string, unknown>[];
  expected: {
    eventCount: number;
    promptCount: number;
    errorCount: number;
    toolCounts: Record<string, number>;
    tokenTotal: number;
    entryCount: number;
    transcriptBytes: number;
    chunkCount: number;
  };
}

const USAGE = {
  input_tokens: 100,
  output_tokens: 50,
  cache_creation_input_tokens: 10,
  cache_read_input_tokens: 5,
};

/** Build a coherent synthetic session from options (all fields have sane defaults). */
export function synthSession(opts: SynthOptions): SynthSession {
  const {
    sessionId,
    hostname = "e2e-host",
    cwd = "/tmp/e2e-project",
    model = "claude-opus-4-8",
    startedAt = "2026-01-01T12:00:00.000Z",
    prompts = 3,
    tools = { Bash: 2, Read: 1 },
    errors = 1,
    sidechains = 0,
  } = opts;

  const common = { session_id: sessionId, hostname, cwd, timestamp: startedAt };

  // ── Transcript (message log) ──────────────────────────────────────────────
  const entries: Record<string, unknown>[] = [];
  for (let i = 0; i < prompts; i++) {
    entries.push({
      type: "user",
      uuid: `u${i}`,
      timestamp: startedAt,
      message: { role: "user", content: `prompt ${i}` },
    });
    entries.push({
      type: "assistant",
      uuid: `a${i}`,
      timestamp: startedAt,
      message: {
        id: `am${i}`,
        role: "assistant",
        model,
        usage: { ...USAGE },
        content: [{ type: "text", text: `reply ${i}` }],
      },
    });
  }
  // Subagent sub-transcript lines: real transcript entries (counted + token-summed),
  // but not part of the main-session rollups.
  for (let i = 0; i < sidechains; i++) {
    entries.push({
      type: "assistant",
      uuid: `s${i}`,
      timestamp: startedAt,
      isSidechain: true,
      message: {
        id: `sm${i}`,
        role: "assistant",
        model,
        usage: { ...USAGE },
        content: [{ type: "text", text: `subagent ${i}` }],
      },
    });
  }
  const transcript = entries.map((e) => JSON.stringify(e)).join("\n");
  const tokenUsage = sumTranscriptTokens(transcript);
  const transcriptBytes = Buffer.byteLength(transcript);

  // ── Event marker docs ─────────────────────────────────────────────────────
  const eventDocs: Record<string, unknown>[] = [];
  const ev = (event: string, extra: Record<string, unknown> = {}) =>
    eventDocs.push({ type: "event", event, ...common, ...extra });

  ev("SessionStart", { model });
  for (let i = 0; i < prompts; i++) ev("UserPromptSubmit", { prompt_preview: `prompt ${i}` });
  for (const [tool, count] of Object.entries(tools)) {
    for (let i = 0; i < count; i++) ev("PostToolUse", { tool_name: tool });
  }
  for (let i = 0; i < errors; i++)
    ev("PostToolUseFailure", { tool_name: "Bash", error_preview: "boom" });
  ev("Stop");
  ev("SessionEnd", { reason: "clear" });

  // ── Chunk docs (byte-faithful, same slicing as live/backfill) ─────────────
  const chunkDocs: Record<string, unknown>[] = sliceIntoChunks(transcript).map((slice) => ({
    _id: chunkDocId(sessionId, slice.byteStart),
    type: "chunk",
    ...common,
    byte_start: slice.byteStart,
    byte_end: slice.byteEnd,
    entry_count: slice.entryCount,
    schema_version: 1,
  }));

  // ── Summary rollup doc ────────────────────────────────────────────────────
  const summaryDoc: Record<string, unknown> = {
    _id: `summary:${sessionId}`,
    type: "summary",
    event: "SessionEnd",
    ...common,
    model,
    end_reason: "clear",
    event_count: eventDocs.length,
    prompt_count: prompts,
    error_count: errors,
    tool_counts: tools,
    transcript_bytes: transcriptBytes,
    token_usage: tokenUsage,
    source: "e2e",
  };

  return {
    sessionId,
    transcript,
    summaryDoc,
    eventDocs,
    chunkDocs,
    expected: {
      eventCount: eventDocs.length,
      promptCount: prompts,
      errorCount: errors,
      toolCounts: tools,
      tokenTotal: tokenUsage.total,
      entryCount: entries.length,
      transcriptBytes,
      chunkCount: chunkDocs.length,
    },
  };
}

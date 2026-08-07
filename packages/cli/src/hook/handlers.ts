/**
 * The hook actions, keyed the same way the app model binds them to events.
 *
 * These are the only implementation. The plugin under `hooks/` used to mirror them —
 * same doc shapes, same ids, same `/tmp` state — but it now pipes its payload to
 * `claude-transcripts hook run`, so a session logged through the plugin is logged by
 * exactly this code. `@claude-transcripts/shared` is imported directly; nothing here
 * is duplicated anywhere.
 *
 * Every handler is best-effort; the dispatcher swallows what they throw.
 */
import { readFileSync } from "node:fs";
import {
  buildChunkEntries,
  chunkDocId,
  sliceIntoChunks,
  sumTranscriptTokens,
} from "@claude-transcripts/shared";
import { commonFields, type HookContext, makeChunkState } from "./runtime";

export type Handler = (ctx: HookContext) => Promise<void>;

/** Reset per-session counters + chunk offset, but only for a genuinely new session. */
const seedSessionStart: Handler = async (ctx) => {
  const source = ctx.payload?.source;
  // A resume or compact continues the same transcript, so the byte offset must survive.
  if (!source || source === "startup" || source === "clear") {
    ctx.counts.reset();
    makeChunkState(ctx.sessionId).seed();
  }
};

const updateCounts: Handler = async (ctx) => {
  ctx.counts.inc("events");
  if (ctx.event === "UserPromptSubmit") ctx.counts.inc("prompts");
  else if (ctx.event === "PostToolUseFailure" || ctx.event === "StopFailure")
    ctx.counts.inc("errors");
  else if (ctx.event === "PostToolUse" && ctx.payload.tool_name)
    ctx.counts.incTool(ctx.payload.tool_name);
};

/** Append-only `event` marker: common fields plus a few light, event-specific ones. */
const writeEventMarker: Handler = async (ctx) => {
  const p = ctx.payload;
  const doc: Record<string, unknown> = { type: "event", ...commonFields(ctx) };

  switch (ctx.event) {
    case "SessionStart":
      doc.source = p.source;
      doc.model = p.model;
      doc.permission_mode = p.permission_mode;
      break;
    case "UserPromptSubmit": {
      const prompt = String(p.prompt ?? "");
      doc.prompt_length = prompt.length;
      doc.prompt_preview = prompt.slice(0, 200);
      break;
    }
    case "PostToolUse":
      doc.tool_name = p.tool_name;
      doc.tool_use_id = p.tool_use_id;
      doc.input_preview = JSON.stringify(p.tool_input ?? "").slice(0, 200);
      break;
    case "PostToolUseFailure":
      doc.tool_name = p.tool_name;
      doc.error_preview = String(p.error ?? p.message ?? "").slice(0, 200);
      doc.is_interrupt = Boolean(p.is_interrupt);
      break;
    case "Stop":
      doc.stop_hook_active = true;
      break;
    case "SubagentStart":
    case "SubagentStop":
      doc.agent_id = p.agent_id;
      doc.agent_type = p.agent_type;
      break;
    case "StopFailure":
      doc.error_type = p.error_type;
      doc.error_preview = String(p.error_message ?? "").slice(0, 200);
      break;
    case "PreCompact":
    case "PostCompact":
      doc.trigger = p.trigger;
      break;
  }
  await ctx.couch.postDoc(ctx.sessionsDb, doc);
};

/**
 * Tail the live transcript into append-only `chunk` docs.
 *
 * Only the bytes since the last flush are read, sliced on complete lines, and written
 * with deterministic ids so a re-flush replaces rather than duplicates. The trailing
 * partial chunk is held back to accumulate unless forced (Stop/SessionEnd, when the
 * file has settled) or the flush interval has elapsed.
 */
const flushTranscriptChunk: Handler = async (ctx) => {
  if (!ctx.config.features?.midFlightChunking) return;
  if (!ctx.transcriptPath) return;

  const forced = ctx.event === "Stop" || ctx.event === "SessionEnd";
  const { maxEntriesPerChunk: max, flushIntervalMs } = ctx.config.system.logging.chunk;
  const cs = makeChunkState(ctx.sessionId);

  if (!cs.acquire()) return; // another flush holds the lock; the next one catches up
  try {
    const state = cs.load();
    const tail = cs.readTail(ctx.transcriptPath, state.offset);
    if (!tail) return;

    const lastNewline = tail.lastIndexOf("\n");
    const completeEnd = forced ? tail.length : lastNewline + 1;
    if (completeEnd <= 0) return; // no complete line yet
    const complete = tail.slice(0, completeEnd);

    const slices = sliceIntoChunks(complete, max);
    if (!slices.length) return;

    const now = Date.now();
    // Guard the unseeded baseline — only time-flush once we have one.
    const timeElapsed = state.lastFlushMs > 0 && now - state.lastFlushMs >= flushIntervalMs;
    const last = slices[slices.length - 1];
    let emit = slices.length;
    if (last && last.entryCount < max && !(forced || timeElapsed)) emit -= 1;
    if (emit <= 0) return;

    const withContent = ctx.config.features?.couchFullContentChunks === true;
    const allEntries = withContent ? buildChunkEntries(complete) : undefined;
    let entryCursor = 0;
    let advance = state.offset;

    for (let i = 0; i < emit; i++) {
      const s = slices[i];
      if (!s) continue;
      const byteStart = state.offset + s.byteStart;
      const byteEnd = state.offset + s.byteEnd;
      const entries = allEntries?.slice(entryCursor, entryCursor + s.entryCount);
      entryCursor += s.entryCount;
      await ctx.couch.putDoc(ctx.sessionsDb, chunkDocId(ctx.sessionId, byteStart), {
        type: "chunk",
        session_id: ctx.sessionId,
        byte_start: byteStart,
        byte_end: byteEnd,
        entry_count: s.entryCount,
        timestamp: ctx.timestamp,
        hostname: ctx.hostname,
        cwd: ctx.cwd,
        schema_version: withContent ? 2 : 1,
        source: "live",
        ...(entries ? { entries } : {}),
      });
      advance = byteEnd;
    }
    cs.save({ offset: advance, lastFlushMs: now });
  } finally {
    cs.release();
    if (ctx.event === "SessionEnd") cs.clear();
  }
};

/** At SessionEnd, write the rollup — its existence is what marks a session `ended`. */
const writeSummary: Handler = async (ctx) => {
  const counts = ctx.counts.read();
  let jsonl = "";
  let transcriptBytes = 0;
  if (ctx.transcriptPath) {
    try {
      jsonl = readFileSync(ctx.transcriptPath, "utf8");
      transcriptBytes = Buffer.byteLength(jsonl);
    } catch {
      // unreadable — record what we can
    }
  }

  const doc = {
    type: "summary",
    ...commonFields(ctx),
    end_reason: ctx.payload?.reason ?? "unknown",
    event_count: counts.events,
    prompt_count: counts.prompts,
    error_count: counts.errors,
    tool_counts: counts.tools,
    transcript_bytes: transcriptBytes,
    token_usage: sumTranscriptTokens(jsonl),
    system_checks: {},
    source: "live",
  };

  await ctx.couch.putDoc(ctx.sessionsDb, `summary:${ctx.sessionId}`, doc, 30000);
  if (ctx.blob.enabled && ctx.sessionsBucket) {
    await ctx.blob.put(
      ctx.sessionsBucket,
      `${ctx.sessionId}/summary.json`,
      JSON.stringify(doc),
      "application/json",
    );
  }
  ctx.counts.clear();
};

/** At SessionEnd, upload the byte-faithful transcript — S3 is its durable home. */
const uploadBlobs: Handler = async (ctx) => {
  if (!ctx.blob.enabled || !ctx.sessionsBucket || !ctx.transcriptPath) return;
  let data: string;
  try {
    data = readFileSync(ctx.transcriptPath, "utf8");
  } catch {
    return;
  }
  await ctx.blob.put(
    ctx.sessionsBucket,
    `${ctx.sessionId}/transcript.jsonl`,
    data,
    "application/x-ndjson",
  );
};

/** Action key → implementation. Keys match the app model's `ActionDef`s. */
export const HANDLERS: Record<string, Handler> = {
  "seed-session-start": seedSessionStart,
  "update-counts": updateCounts,
  "write-event-marker": writeEventMarker,
  "flush-transcript-chunk": flushTranscriptChunk,
  "write-summary": writeSummary,
  "upload-blobs": uploadBlobs,
};

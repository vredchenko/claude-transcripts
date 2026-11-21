/**
 * The hook actions, keyed the same way the blueprint binds them to events.
 *
 * These are the only implementation. The plugin under `hooks/` used to mirror them —
 * same doc shapes, same ids, same `/tmp` state — but it now pipes its payload to
 * `claude-transcripts hook run`, so a session logged through the plugin is logged by
 * exactly this code. `@claude-transcripts/shared` is imported directly; nothing here
 * is duplicated anywhere.
 *
 * Every handler is best-effort; the dispatcher swallows what they throw.
 */
import { readFileSync, statSync } from "node:fs";
import {
  buildChunkEntries,
  chunkDocId,
  scanTranscript,
  sliceIntoChunks,
} from "@claude-transcripts/shared";
import { recordingBanner, unreachableBanner } from "./announce";
import type { IngestClient } from "./ingest";
import { buildPrimer } from "./recall";
import { commonFields, type HookContext, makeChunkState, resolveTargets } from "./runtime";

export type Handler = (ctx: HookContext) => Promise<void>;

/**
 * Reset per-session counters + chunk offset, but only for a genuinely new session.
 *
 * A resume or compact keeps the offset, so flushes stay on the stored chunk boundaries
 * (#168). With no usable local offset (`/tmp` lost to a reboot) it is seeded from the
 * webapi's chunk high-water; an offset past the end of the file — a rewritten transcript —
 * is never used, since nothing would be chunked until the file grew past it.
 */
const seedSessionStart: Handler = async (ctx) => {
  const source = ctx.payload?.source;
  // The resolved targets, for the statusline and the banner. Always rewritten: config
  // can change between a session's start and its resume, and the file is cheap.
  // `lastWriteMs` starts at 0 — "recording" is earned by a write landing, not claimed.
  ctx.targets.write(resolveTargets(ctx.config));

  const cs = makeChunkState(ctx.sessionId);
  if (!source || source === "startup" || source === "clear") {
    ctx.counts.reset();
    cs.seed();
    return;
  }
  if (!ctx.config.features?.midFlightChunking) return;
  const size = fileSize(ctx.transcriptPath);
  const fits = (offset: number) => size === null || offset <= size;
  const local = cs.load().offset;
  if (local > 0 && fits(local)) return;
  const highWater = await ctx.chunkHighWater();
  cs.seed(highWater !== null && fits(highWater) ? highWater : 0);
};

function fileSize(path: string | undefined): number | null {
  try {
    return path ? statSync(path).size : null;
  } catch {
    return null;
  }
}

/**
 * Tell the user, in the transcript, that this session is recorded and where.
 *
 * Reads the targets `seed-session-start` just wrote rather than resolving again, so
 * the banner and the statusline can't disagree. Actions run concurrently, so the seed
 * may not have landed yet — resolve inline in that case; same inputs, same answer.
 */
const announceRecording: Handler = async (ctx) => {
  // Checked before the first write rather than discovered by it (#288): a webapi that is
  // down now loses this session's events, and the banner is where that gets noticed.
  const reachable = await ctx.probe();
  if (!reachable.ok) ctx.targets.markWrite(reachable, 0);
  const targets = ctx.targets.read() ?? resolveTargets(ctx.config);
  ctx.output.systemMessage = reachable.ok
    ? recordingBanner(targets, ctx.sessionId)
    : unreachableBanner(targets, reachable.reason);
};

/**
 * Say whether the running Claude Code matches the hook spec this build was made for —
 * one line when it does, a short drift summary when it doesn't (`hook/compat.ts`).
 * Skipped after a compaction: same session, same binary, already said.
 */
const checkHookCompat: Handler = async (ctx) => {
  if (ctx.payload?.source === "compact") return;
  const lines = ctx.hookCompat();
  if (lines.length) ctx.output.notices = [...(ctx.output.notices ?? []), ...lines];
};

/**
 * Prime the session with the recall policy and how much history this cwd has, so
 * Claude knows there is something here to find — not merely that history is a concept.
 * Omitted entirely when the policy is off, the cwd is excluded, the corpus for it is
 * empty, or the webapi doesn't answer in time.
 */
const injectRecallPolicy: Handler = async (ctx) => {
  const primer = await buildPrimer(ctx);
  if (primer) ctx.output.additionalContext = primer;
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
    case "PostModelSwitch":
      doc.from_model = p.from_model;
      doc.to_model = p.to_model;
      doc.requested_model = p.requested_model;
      doc.source = p.source;
      doc.estimated_cache_write_usd = p.estimated_cache_write_usd;
      break;
    case "CwdChanged":
      doc.old_cwd = p.old_cwd;
      doc.new_cwd = p.new_cwd;
      break;
    case "DirectoryAdded":
      doc.directory = p.directory;
      doc.source = p.source;
      break;
  }
  await ctx.writer.event(doc);
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
      await ctx.writer.chunk({
        _id: chunkDocId(ctx.sessionId, byteStart),
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
    // Only the lock goes, SessionEnd included: the offset is what a resume of this
    // session continues from (see seedSessionStart).
    cs.release();
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

  // One pass for tokens and models: SessionEnd runs on a tight exit budget (#217).
  const scan = scanTranscript(jsonl);
  const doc = {
    type: "summary",
    ...commonFields(ctx),
    end_reason: ctx.payload?.reason ?? "unknown",
    event_count: counts.events,
    prompt_count: counts.prompts,
    error_count: counts.errors,
    tool_counts: counts.tools,
    transcript_bytes: transcriptBytes,
    token_usage: scan.tokenUsage,
    ...(scan.models.length ? { models: scan.models } : {}),
    system_checks: {},
    source: "live",
  };

  await ctx.writer.summary({ _id: `summary:${ctx.sessionId}`, ...doc }, 30000);
  // Targets go: the statusline reads them per session, and a finished session is not
  // recording. Counts stay. A session can be resumed after SessionEnd, and
  // `seedSessionStart` deliberately does *not* reset them on a resume so the totals keep
  // accumulating — clearing them here defeated that, and the second SessionEnd wrote a
  // summary describing only the resumed tail (17 events of a 371-event session). Now
  // that the summary actually replaces the stored one, that tail would have overwritten
  // the real figures.
  ctx.targets.clear();
};

/** Upload one session's byte-faithful transcript; the webapi keeps it in S3 (ADR 0014). */
export async function uploadTranscript(
  writer: IngestClient,
  sessionId: string,
  transcriptPath: string,
): Promise<void> {
  let data: string;
  try {
    data = readFileSync(transcriptPath, "utf8");
  } catch {
    return;
  }
  await writer.transcript(sessionId, data);
}

/**
 * At SessionEnd, hand the transcript upload to a detached `hook upload` and return.
 *
 * Claude Code cancels SessionEnd when its exit budget runs out, whatever timeout is
 * registered, and a long session's transcript is megabytes (#217, see `detach.ts`).
 * The summary and the final chunk are small and stay in-line. Only if the child
 * cannot start does the upload run here, which is the old behaviour.
 */
const uploadBlobs: Handler = async (ctx) => {
  if (!ctx.transcriptPath) return;
  if (ctx.detachUpload(ctx.sessionId, ctx.transcriptPath)) return;
  await uploadTranscript(ctx.writer, ctx.sessionId, ctx.transcriptPath);
};

/** Action key → implementation. Keys match the blueprint's `ActionDef`s. */
export const HANDLERS: Record<string, Handler> = {
  "seed-session-start": seedSessionStart,
  "announce-recording": announceRecording,
  "check-hook-compat": checkHookCompat,
  "inject-recall-policy": injectRecallPolicy,
  "update-counts": updateCounts,
  "write-event-marker": writeEventMarker,
  "flush-transcript-chunk": flushTranscriptChunk,
  "write-summary": writeSummary,
  "upload-blobs": uploadBlobs,
};

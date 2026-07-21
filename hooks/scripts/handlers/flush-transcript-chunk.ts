import { makeChunkState } from "../lib/chunk-state";
import type { HookContext } from "../lib/context";
import { chunkDocId, sliceIntoChunks } from "../transcript-chunks";

/**
 * Action `flush-transcript-chunk`: incrementally tail the live transcript into
 * append-only, byte-faithful `chunk` docs (crash resilience + content reassembly by
 * byte order). Reads only the NEW bytes since the last flush (byte-offset state in
 * /tmp), slices them into ≤`maxEntriesPerChunk` chunks, and writes them; the
 * trailing partial chunk is held to accumulate unless forced (Stop/SessionEnd) or
 * the flush interval elapsed. So live chunks match how `backfill` stores them
 * (same shape, same byte-faithful tiling). Gated behind `features.midFlightChunking`.
 *
 * TODO(couchFullContentChunks): when that flag is on, also embed the pruned parsed
 * `entries[]` in each chunk (and mirror it in the CLI's buildChunkDocs). Deferred —
 * chunks are metadata-only for now.
 */
export async function handle(ctx: HookContext): Promise<void> {
  if (!ctx.config.features?.midFlightChunking) return;
  if (!ctx.transcriptPath) return;

  const forced = ctx.event === "Stop" || ctx.event === "SessionEnd";
  const { maxEntriesPerChunk: max, flushIntervalMs } = ctx.config.system.logging.chunk;
  const cs = makeChunkState(ctx.sessionId);

  if (!cs.acquire()) return; // another flush is in progress — skip; the next one catches up
  try {
    const state = cs.load();
    const tail = cs.readTail(ctx.transcriptPath, state.offset);
    if (!tail) return;

    // Only chunk COMPLETE lines; a partial trailing line is held for next flush
    // (a forced flush at Stop/SessionEnd takes everything — the file is settled).
    const lastNewline = tail.lastIndexOf("\n");
    const completeEnd = forced ? tail.length : lastNewline + 1;
    if (completeEnd <= 0) return; // no complete line yet
    const complete = tail.slice(0, completeEnd);

    const slices = sliceIntoChunks(complete, max);
    if (!slices.length) return;

    // Emit full chunks always; the trailing partial only when forced or the flush
    // interval elapsed — otherwise hold it (don't advance past it) to accumulate.
    const now = Date.now();
    // Guard the unseeded baseline (lastFlushMs 0) — only time-flush once we have one.
    const timeElapsed = state.lastFlushMs > 0 && now - state.lastFlushMs >= flushIntervalMs;
    const last = slices[slices.length - 1];
    let emit = slices.length;
    if (last.entryCount < max && !(forced || timeElapsed)) emit -= 1;
    if (emit <= 0) return;

    let advance = state.offset;
    for (let i = 0; i < emit; i++) {
      const s = slices[i];
      const byteStart = state.offset + s.byteStart;
      const byteEnd = state.offset + s.byteEnd;
      const doc = {
        type: "chunk" as const,
        session_id: ctx.sessionId,
        byte_start: byteStart,
        byte_end: byteEnd,
        entry_count: s.entryCount,
        timestamp: ctx.timestamp,
        hostname: ctx.hostname,
        cwd: ctx.cwd,
        schema_version: 1,
        source: "live",
      };
      await ctx.couch.putDoc(ctx.sessionsDb, chunkDocId(ctx.sessionId, byteStart), doc);
      advance = byteEnd;
    }
    cs.save({ offset: advance, lastFlushMs: now });
  } finally {
    cs.release();
    if (ctx.event === "SessionEnd") cs.clear(); // session done — drop the /tmp state
  }
}

import { makeChunkState } from "../lib/chunk-state";
import type { HookContext } from "../lib/context";

/** Action `seed-session-start`: at the start of a *fresh* session, reset the
 *  per-session counters and the mid-flight chunk offset. A resume/compact keeps the
 *  existing state, since the transcript (and our byte offset into it) continues. */
export async function handle(ctx: HookContext): Promise<void> {
  const source = ctx.payload?.source;
  if (!source || source === "startup" || source === "clear") {
    ctx.counts.reset();
    makeChunkState(ctx.sessionId).seed();
  }
}

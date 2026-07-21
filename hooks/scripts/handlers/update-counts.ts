import type { HookContext } from "../lib/context";

/** Action `update-counts`: bump the per-session counters by event type. */
export async function handle(ctx: HookContext): Promise<void> {
  ctx.counts.inc("events");
  if (ctx.event === "UserPromptSubmit") {
    ctx.counts.inc("prompts");
  } else if (ctx.event === "PostToolUseFailure" || ctx.event === "StopFailure") {
    ctx.counts.inc("errors");
  } else if (ctx.event === "PostToolUse" && ctx.payload.tool_name) {
    ctx.counts.incTool(ctx.payload.tool_name);
  }
}

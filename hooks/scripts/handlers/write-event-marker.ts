import { commonFields, type HookContext } from "../lib/context";

/** Action `write-event-marker`: append an append-only `event` marker doc — common
 *  fields + light, event-specific fields. Rich content comes from the chunk flush. */
export async function handle(ctx: HookContext): Promise<void> {
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
    // Scaffold cases (newly wired) — field names per docs/hook-events.md; confirm
    // against a real payload + compatibility.json before relying on them.
    case "StopFailure":
      doc.error_type = p.error_type;
      doc.error_preview = String(p.error_message ?? "").slice(0, 200);
      break;
    case "PreCompact":
    case "PostCompact":
      doc.trigger = p.trigger; // "manual" | "auto"
      break;
  }

  await ctx.couch.postDoc(ctx.sessionsDb, doc);
}

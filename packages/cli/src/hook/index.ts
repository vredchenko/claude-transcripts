/**
 * Hook dispatch: read one Claude Code hook payload on stdin and run the bound actions.
 *
 * Event → action bindings come straight from the app model, so this can't drift from
 * the registration written into Claude Code's settings (both are projections of the
 * same source). The standalone plugin codegens the same bindings into a JSON file
 * because it can't resolve the workspace; the CLI simply reads the model.
 *
 * Nothing here is allowed to fail loudly. Actions run concurrently and settled, errors
 * are logged to stderr and swallowed, and the caller always exits 0 — Claude Code
 * treats a non-zero hook as a problem, and a logging tool must never become one.
 */
import { buildAppModel } from "@claude-transcripts/shared";
import { loadAppConfig } from "../lib/app-config";
import { emitSessionStart, NOT_RECORDING_BANNER } from "./announce";
import { HANDLERS } from "./handlers";
import { buildContext, type HookConfig, loadHookConfig } from "./runtime";

/** Event → action keys, projected from the app model. */
export function hookBindings(): Record<string, string[]> {
  const model = buildAppModel(loadAppConfig(), process.env);
  const out: Record<string, string[]> = {};
  for (const b of model.bindings) out[b.event] = b.actions;
  return out;
}

/**
 * Per-event command timeout (seconds) for the registration.
 *
 * Session start and end do real work — seeding state, and writing the summary plus
 * uploading the transcript — so they get a long budget. Everything else is a small
 * append that should never hold up a turn. Mirrors `scripts/sync-hooks.ts`, which
 * writes the same numbers into the standalone plugin's registration.
 */
const LONG_TIMEOUT_EVENTS = new Set(["SessionStart", "SessionEnd"]);

export function hookTimeout(event: string): number {
  return LONG_TIMEOUT_EVENTS.has(event) ? 180 : 5;
}

/**
 * Events registered fire-and-forget (`async: true`), so the writer never holds up a turn.
 *
 * A timeout caps the delay; it does not remove it. Measured against a tailnet instance,
 * a synchronous `PostToolUse` costs ~130-160 ms — paid on *every* tool call, which is
 * the difference between "a small append" and a tax on the whole session.
 *
 * The three exclusions are deliberate, and each would be a real bug if included:
 *  - `SessionStart` runs `announce-recording` + `inject-recall-policy`, both of which
 *    write into the session. Claude Code discards an async hook's output, so this would
 *    silently drop the banner and the recall primer.
 *  - `SessionEnd` writes the summary and uploads the transcript. Fire-and-forget at
 *    teardown risks being reaped mid-upload, which loses data.
 *  - `UserPromptSubmit` is decision-shaped; Claude Code ignores `async` there, so
 *    claiming it would be a lie in the registration.
 *
 * Everything else binds only to `write-event-marker` / `update-counts` /
 * `flush-transcript-chunk` — pure writes with nothing session-visible. Mirrors
 * `scripts/sync-hooks.ts`, which writes the same flags into the plugin's registration.
 */
const SYNCHRONOUS_EVENTS = new Set(["SessionStart", "SessionEnd", "UserPromptSubmit"]);

export function hookAsync(event: string): boolean {
  return !SYNCHRONOUS_EVENTS.has(event);
}

export interface DispatchResult {
  /** False when we deliberately did nothing (no config, or an unusable payload). */
  ran: boolean;
  event?: string;
  actions: string[];
}

/** Run every action bound to this payload's event. Never throws. */
export async function dispatch(raw: string, configPath: string): Promise<DispatchResult> {
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return { ran: false, actions: [] };
  }

  const config: HookConfig | null = loadHookConfig(configPath);
  if (!config) {
    // Not installed → do nothing, but not *silently*: on SessionStart say so, in the
    // transcript. A hook that can't record and a hook that is quietly recording look
    // identical otherwise, and the difference is a week of lost history. This is the
    // one thing that runs ahead of the config gate (docs/design/plugin.md, Part 1a).
    if ((payload as { hook_event_name?: string })?.hook_event_name === "SessionStart") {
      emitSessionStart({ systemMessage: NOT_RECORDING_BANNER });
    }
    return { ran: false, actions: [] };
  }

  // `buildContext` constructs the store clients, and a client constructor reads the
  // config eagerly — so a config this function cannot use throws here, outside the
  // per-handler catch below, past this function's "never throws" contract, and out
  // through the hook process. Recording is the one thing that must not turn a broken
  // config into a broken session, so the same swallow applies at construction as at
  // dispatch: log it once and do nothing.
  let ctx: ReturnType<typeof buildContext>;
  try {
    ctx = buildContext(payload, config);
  } catch (err) {
    console.error("[hook] could not build context (ignored):", err);
    return { ran: false, actions: [] };
  }
  if (!ctx) return { ran: false, actions: [] };

  const actions = hookBindings()[ctx.event] ?? [];
  await Promise.allSettled(
    actions.map(async (key) => {
      const handler = HANDLERS[key];
      if (!handler) return;
      try {
        await handler(ctx);
      } catch (err) {
        console.error(`[hook] action ${key} failed (ignored):`, err);
      }
    }),
  );
  // One JSON object on stdout, and only for SessionStart (see HookContext.output).
  if (ctx.event === "SessionStart") emitSessionStart(ctx.output);
  return { ran: true, event: ctx.event, actions };
}

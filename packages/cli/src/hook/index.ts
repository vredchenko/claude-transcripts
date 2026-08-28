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
      emitSessionStart(NOT_RECORDING_BANNER);
    }
    return { ran: false, actions: [] };
  }

  const ctx = buildContext(payload, config);
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
  return { ran: true, event: ctx.event, actions };
}

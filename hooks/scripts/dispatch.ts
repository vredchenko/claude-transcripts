#!/usr/bin/env bun
/**
 * Single entry point for every registered Claude Code hook event. Reads the hook
 * payload on stdin, builds a context, and runs the bound **actions**.
 *
 * The event → action bindings are PROJECTED FROM THE APP MODEL by
 * scripts/sync-hooks.ts into bindings.generated.json (the hook is standalone and
 * can't import the workspace, so the model is codegen'd in). Each action key maps
 * to handlers/<action>.ts.
 *
 * The hook NEVER blocks a session: every call is wrapped and failures swallowed.
 */
import bindings from "./bindings.generated.json";
import { buildContext } from "./lib/context";

const BINDINGS = bindings as Record<string, string[]>;

async function main() {
  const raw = await Bun.stdin.text();
  let payload: any;
  try {
    payload = JSON.parse(raw);
  } catch {
    return;
  }

  const ctx = buildContext(payload);
  if (!ctx) return; // no config, or missing event/session id → silent skip

  const actions = BINDINGS[ctx.event] ?? [];
  await Promise.allSettled(
    actions.map(async (action) => {
      try {
        const mod = await import(`./handlers/${action}.ts`);
        await mod.handle(ctx);
      } catch (err) {
        console.error(`[hook] action ${action} failed (ignored):`, err);
      }
    }),
  );
}

await main();

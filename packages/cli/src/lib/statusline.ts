/**
 * The statusline indicator, rendered from the hook's own per-session scratch state
 * (docs/design/plugin.md, Part 1b).
 *
 *   ● ct rec · 128 ev · 6 tools · 2s ago → claude-transcripts-sessions@127.0.0.1:7652
 *   ◐ ct stalled · 128 ev · last write 6m ago → …           (configured, writes failing)
 *   ○ ct off · no instance configured
 *
 * Runs on every statusline refresh, so it does **no network I/O** — ever. Everything
 * it shows is what the hook already wrote to `/tmp` while recording: the counters
 * (`makeCounts`) and the resolved targets plus last-write time (`makeTargets`). That
 * last field is what separates "recording" from "configured but failing": a store that
 * has refused writes for five minutes must not get a confident green dot.
 */
import type { Counts, Targets } from "../hook/runtime";

/** What Claude Code pipes to a statusline command. Only the fields we read. */
export interface StatuslineInput {
  session_id?: string;
}

export interface StatuslineState {
  configured: boolean;
  targets: Targets | null;
  counts: Counts | null;
}

/** A failure newer than the last success, and no success within this window → stalled. */
export const STALL_AFTER_MS = 60_000;

export function ago(ms: number, now: number): string {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  return `${Math.round(m / 60)}h ago`;
}

/** `db@host:port` — the store, short enough for a statusline. */
export function whereLabel(t: Targets): string {
  const host = t.couchUrl.replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  return `${t.sessionsDb}@${host}`;
}

export function renderStatusline(state: StatuslineState, now = Date.now()): string {
  if (!state.configured) return "○ ct off · no instance configured";
  const t = state.targets;
  if (!t) return "○ ct off · not recording this session";

  const c = state.counts;
  const toolCalls = c ? Object.values(c.tools).reduce((a, b) => a + b, 0) : 0;
  const counts = c ? `${c.events} ev · ${toolCalls} tools` : "0 ev";

  const written = t.lastWriteMs > 0;
  const failing = t.lastFailureMs > t.lastWriteMs && now - t.lastWriteMs > STALL_AFTER_MS;
  if (failing) {
    const last = written ? `last write ${ago(t.lastWriteMs, now)}` : "no write landed";
    return `◐ ct stalled · ${counts} · ${last} → ${whereLabel(t)}`;
  }
  if (!written) return `◌ ct ready · ${counts} · no write yet → ${whereLabel(t)}`;
  return `● ct rec · ${counts} · ${ago(t.lastWriteMs, now)} → ${whereLabel(t)}`;
}

/**
 * The statusline indicator, rendered from the hook's own per-session scratch state
 * (docs/design/plugin.md, Part 1b).
 *
 *   ● ct rec · 128 ev · 6 tools · 2s ago → claude-transcripts-sessions@127.0.0.1:7652
 *   ● ct rec (mirror) · 128 ev · 2s ago → logs.example.net  (primary dead, mirror taking writes)
 *   ◐ ct stalled · 128 ev · last write 6m ago → …           (configured, writes failing)
 *   ○ ct off · no instance configured
 *
 * Runs on every statusline refresh, so it does **no network I/O** — ever. Everything
 * it shows is what the hook already wrote to `/tmp` while recording: the counters
 * (`makeCounts`) and the resolved targets plus last-write time (`makeTargets`). That
 * last field is what separates "recording" from "configured but failing": a store that
 * has refused writes for five minutes must not get a confident green dot.
 *
 * Health is read per store, because a machine that reports into a shared instance
 * routinely has a dead primary and a live mirror. Collapsing those into one verdict is
 * wrong in both directions — a permanent red on a machine recording perfectly well, or
 * a green dot labelled with a host that has accepted nothing for weeks — so the label
 * names whichever store is actually taking the writes, and says when that is a mirror.
 */
import type { Counts, StoreHealth, Targets } from "../hook/runtime";

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

/** One store's verdict. `idle` is "nothing tried yet", not "nothing worked". */
export type StoreState = "healthy" | "failing" | "idle";

/**
 * A store is failing once a rejection is newer than its last success *and* that success
 * has aged out of the stall window. A store that has never written is failing only if
 * something was actually rejected — otherwise it is merely idle.
 */
export function storeState(
  s: Pick<StoreHealth, "lastWriteMs" | "lastFailureMs">,
  now: number,
): StoreState {
  if (s.lastFailureMs > s.lastWriteMs && now - s.lastWriteMs > STALL_AFTER_MS) return "failing";
  return s.lastWriteMs > 0 ? "healthy" : "idle";
}

export function renderStatusline(state: StatuslineState, now = Date.now()): string {
  if (!state.configured) return "○ ct off · no instance configured";
  const t = state.targets;
  if (!t) return "○ ct off · not recording this session";

  const c = state.counts;
  const toolCalls = c ? Object.values(c.tools).reduce((a, b) => a + b, 0) : 0;
  const counts = c ? `${c.events} ev · ${toolCalls} tools` : "0 ev";

  // A targets file written by an older binary has no per-store health. Render it exactly
  // as that binary did rather than showing "off" at a session that is recording fine.
  const stores = t.stores?.length ? t.stores : null;
  if (!stores) {
    const written = t.lastWriteMs > 0;
    const failing = t.lastFailureMs > t.lastWriteMs && now - t.lastWriteMs > STALL_AFTER_MS;
    if (failing) {
      const last = written ? `last write ${ago(t.lastWriteMs, now)}` : "no write landed";
      return `◐ ct stalled · ${counts} · ${last} → ${whereLabel(t)}`;
    }
    if (!written) return `◌ ct ready · ${counts} · no write yet → ${whereLabel(t)}`;
    return `● ct rec · ${counts} · ${ago(t.lastWriteMs, now)} → ${whereLabel(t)}`;
  }

  const direct = stores.find((s) => s.kind === "direct") ?? stores[0];
  const headline = direct ?? { label: whereLabel(t), lastWriteMs: 0, lastFailureMs: 0 };

  if (direct && storeState(direct, now) === "healthy") {
    return `● ct rec · ${counts} · ${ago(direct.lastWriteMs, now)} → ${direct.label}`;
  }

  // The primary is not taking writes. If a mirror is, the session IS being recorded —
  // say so, and name the store that has the data rather than the one that does not.
  const healthyMirrors = stores.filter((s) => s !== direct && storeState(s, now) === "healthy");
  const first = healthyMirrors[0];
  if (first) {
    const more = healthyMirrors.length > 1 ? ` +${healthyMirrors.length - 1}` : "";
    return `● ct rec (mirror) · ${counts} · ${ago(first.lastWriteMs, now)} → ${first.label}${more}`;
  }

  if (stores.some((s) => storeState(s, now) === "failing")) {
    const best = Math.max(...stores.map((s) => s.lastWriteMs));
    const last = best > 0 ? `last write ${ago(best, now)}` : "no write landed";
    return `◐ ct stalled · ${counts} · ${last} → ${headline.label}`;
  }
  return `◌ ct ready · ${counts} · no write yet → ${headline.label}`;
}

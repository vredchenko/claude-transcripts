/** Presentation helpers — pure, no React. Deliberately dependency-free. */

/** Human-readable byte size (1024-based). */
export function formatBytes(bytes: number | undefined): string {
  if (!bytes || bytes <= 0) return "—";
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value < 10 && unit > 0 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

/** Compact integer with thousands separators (locale-independent grouping). */
export function formatCount(n: number | undefined): string {
  if (n === undefined || n === null) return "—";
  return n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** ISO timestamp → "YYYY-MM-DD HH:MM" in local time; falls back to the raw string. */
export function formatTimestamp(iso: string | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (x: number) => String(x).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Milliseconds → "1h 2m", "3m 4s", "5s". */
export function formatDuration(ms: number | undefined): string {
  if (!ms || ms <= 0) return "—";
  const s = Math.round(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${sec}s`;
  return `${sec}s`;
}

/** Trailing path segment of a cwd, for a compact "project" label. */
export function projectName(cwd: string | undefined): string {
  if (!cwd) return "—";
  const parts = cwd.replace(/\/+$/, "").split("/");
  return parts[parts.length - 1] || cwd;
}

/** Sum of a tool-count map. */
export function totalTools(toolCounts: Record<string, number> | undefined): number {
  if (!toolCounts) return 0;
  return Object.values(toolCounts).reduce((a, b) => a + b, 0);
}

// ── Active vs idle time ─────────────────────────────────────────────────────────

/**
 * A session's wall-clock runtime broken into the time something was happening and the
 * time it sat there.
 *
 * The distinction is the whole point of showing both: a session left open in tmux over
 * a weekend reports three days of "runtime" and twenty minutes of work, and a list that
 * only shows the first is actively misleading about where the effort went.
 */
export interface DurationSplit {
  /** Wall-clock: first event to last. */
  totalMs: number;
  /** Working time, or undefined when the API couldn't derive it. */
  activeMs?: number;
  /** Wall-clock minus active; undefined exactly when `activeMs` is. */
  idleMs?: number;
  /** Active share of the total, 0–100. Undefined when there is nothing to divide. */
  activePct?: number;
}

/**
 * Split a runtime into active and idle.
 *
 * Defensive about the two ways the numbers can disagree, because both occur and both
 * would otherwise render as nonsense: `activeMs` can exceed `durationMs` by a rounding
 * step (they're derived from different timestamps), which would draw a negative idle
 * bar; and a session can report active time with no duration at all, where the active
 * figure is the better estimate of the total rather than a reason to show nothing.
 */
export function durationSplit(durationMs?: number, activeMs?: number): DurationSplit {
  const total = Math.max(0, durationMs ?? 0);
  if (activeMs === undefined || activeMs === null || Number.isNaN(activeMs)) {
    return { totalMs: total };
  }
  const active = Math.max(0, activeMs);
  const totalMs = Math.max(total, active);
  const idleMs = totalMs - active;
  return {
    totalMs,
    activeMs: active,
    idleMs,
    activePct: totalMs > 0 ? (active / totalMs) * 100 : undefined,
  };
}

/**
 * The split as one line of prose, for a tooltip: "1h 5m runtime · 24m active (37%) ·
 * 41m idle". Says so plainly when active time isn't known, rather than implying the
 * session was idle throughout.
 */
export function durationSplitLabel(durationMs?: number, activeMs?: number): string {
  const split = durationSplit(durationMs, activeMs);
  if (split.totalMs <= 0) return "No runtime recorded";
  const runtime = `${formatDuration(split.totalMs)} runtime`;
  if (split.activeMs === undefined) return `${runtime} · active time not recorded`;
  const pct = split.activePct === undefined ? "" : ` (${Math.round(split.activePct)}%)`;
  return `${runtime} · ${formatDuration(split.activeMs)} active${pct} · ${formatDuration(split.idleMs)} idle`;
}

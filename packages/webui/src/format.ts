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

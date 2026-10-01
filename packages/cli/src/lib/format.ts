/**
 * Text-table helpers for the data commands' terminal output.
 *
 * Extracted from `sessions` when `search` needed the same column handling. Two
 * commands rendering the same kind of table should agree on how a column is padded
 * and where it's cut, rather than growing near-copies that drift.
 */
import { isatty } from "node:tty";

/**
 * Terminal width, or 0 when stdout isn't a TTY. Only touches `process.stdout` on a
 * TTY: materialising it makes Bun drop the tail of piped `console.log` output (#146).
 */
export function stdoutColumns(): number {
  return isatty(1) ? (process.stdout.columns ?? 0) : 0;
}

/**
 * A Claude Code session id is a UUID — 36 characters. Tables print it whole: `sessions
 * <id>` and `turns <id>` look a session up by its exact id, so a shortened one would
 * be a value the user can see but can't pass back (#146).
 */
export const SESSION_W = 36;

/** A session id as a `row` cell, at least `SESSION_W` wide and never cut. */
export function sessionCell(id: string): [string, number] {
  return [id, Math.max(SESSION_W, id.length)];
}

/** Narrowest a trailing free-text column (snippet, turn text) is allowed to get. */
const MIN_TEXT_W = 30;

/**
 * Width left for a trailing free-text column after fixed columns of `widths` (and the
 * two-space gap `row` puts after each). With no TTY — a pipe — there is no terminal to
 * fit, so assume a generous one rather than cropping text a script may want.
 */
export function restWidth(widths: number[]): number {
  const cols = stdoutColumns();
  const before = widths.reduce((sum, w) => sum + w + 2, 0);
  return Math.max(MIN_TEXT_W, (cols > 0 ? cols : 160) - before);
}

/** Thousands-separated integer. */
export function num(n: number | undefined): string {
  return (n ?? 0).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** The last path segment of a cwd — the project name, as a table cell. */
export function project(cwd: string | undefined): string {
  const parts = (cwd ?? "").replace(/\/+$/, "").split("/");
  return parts[parts.length - 1] || cwd || "—";
}

/** Left-align in `w`, truncating if longer. */
export function pad(s: string, w: number): string {
  return s.length >= w ? s.slice(0, w) : s.padEnd(w);
}

/** Right-align in `w`, leaving over-long values intact (numbers must stay readable). */
export function padL(s: string, w: number): string {
  return s.length >= w ? s : s.padStart(w);
}

/**
 * Join `[text, width]` cells into a row. Columns from `rightFrom` onward are
 * right-aligned — numeric tails read better that way, and the caller knows where its
 * numbers start.
 */
export function row(cols: [string, number][], rightFrom = Number.POSITIVE_INFINITY): string {
  // `trimEnd` because the last column pads out to its width like any other, and a
  // terminal row that ends in spaces is invisible noise that survives copy-paste.
  return cols
    .map(([s, w], i) => (i >= rightFrom ? padL(s, w) : pad(s, w)))
    .join("  ")
    .trimEnd();
}

/** ISO timestamp → `YYYY-MM-DD HH:MM`, or an em dash. */
export function when(ts: string | undefined): string {
  return ts ? ts.replace("T", " ").slice(0, 16) : "—";
}

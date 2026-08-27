/**
 * Text-table helpers for the data commands' terminal output.
 *
 * Extracted from `sessions` when `search` needed the same column handling. Two
 * commands rendering the same kind of table should agree on how a column is padded
 * and where it's cut, rather than growing near-copies that drift.
 */

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

import { readFileSync, writeFileSync } from "node:fs";

/**
 * Replace the text between `<!-- gen:<key>:start … -->` and `<!-- gen:<key>:end -->`
 * in a hand-maintained Markdown file, leaving the prose around it alone. The start
 * marker may carry a note after the key (a "do not edit" hint for readers).
 */
export function spliceBetweenMarkers(path: string, key: string, body: string): boolean {
  const raw = readFileSync(path, "utf8");
  const start = new RegExp(`<!-- gen:${key}:start[^>]*-->\\n`);
  const end = `<!-- gen:${key}:end -->`;
  const s = raw.match(start);
  const e = raw.indexOf(end);
  if (!s || s.index === undefined || e < 0 || e < s.index) {
    throw new Error(`${path}: missing gen:${key} start/end markers`);
  }
  const head = raw.slice(0, s.index + s[0].length);
  const next = `${head}${body}\n${raw.slice(e)}`;
  if (next === raw) return false;
  writeFileSync(path, next);
  return true;
}

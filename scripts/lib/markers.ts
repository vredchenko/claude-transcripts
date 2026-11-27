import { readFileSync, writeFileSync } from "node:fs";

/**
 * Replace the text between a generated region's start and end markers in a
 * hand-maintained file, leaving everything around it alone. The start marker may carry a
 * note after the key (a "do not edit" hint for readers).
 *
 * - `html` (Markdown, HTML): `<!-- gen:<key>:start … -->` … `<!-- gen:<key>:end -->`
 * - `hash` (shell, YAML, Dockerfile): `# gen:<key>:start …` … `# gen:<key>:end`, each
 *   on its own line and indented as the surrounding code is. The body is placed as given,
 *   so it carries its own indentation.
 */
export function spliceBetweenMarkers(
  path: string,
  key: string,
  body: string,
  style: "html" | "hash" = "html",
): boolean {
  const raw = readFileSync(path, "utf8");
  const start =
    style === "html"
      ? new RegExp(`<!-- gen:${key}:start[^>]*-->\\n`)
      : new RegExp(`^[ \\t]*# gen:${key}:start[^\\n]*\\n`, "m");
  const end =
    style === "html"
      ? new RegExp(`<!-- gen:${key}:end -->`)
      : new RegExp(`^[ \\t]*# gen:${key}:end`, "m");
  const s = raw.match(start);
  const e = raw.match(end);
  if (!s || s.index === undefined || !e || e.index === undefined || e.index < s.index) {
    throw new Error(`${path}: missing gen:${key} start/end markers`);
  }
  const head = raw.slice(0, s.index + s[0].length);
  const next = `${head}${body}\n${raw.slice(e.index)}`;
  if (next === raw) return false;
  writeFileSync(path, next);
  return true;
}

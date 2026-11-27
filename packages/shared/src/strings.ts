/**
 * `s` without its trailing slashes, in one linear pass.
 *
 * Not `s.replace(/\/+$/, "")`: a regex engine tries that pattern from every slash, so a
 * long run of slashes that isn't at the end ("////…x") costs quadratic time. That's
 * polynomial ReDoS on anything a user or environment supplies, such as a URL or a cwd.
 */
export function stripTrailingSlashes(s: string): string {
  let end = s.length;
  while (end > 0 && s.charCodeAt(end - 1) === 47 /* "/" */) end--;
  return end === s.length ? s : s.slice(0, end);
}

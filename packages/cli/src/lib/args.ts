/**
 * Minimal flag parser for the data commands: `--key value`, `--key=value`, and
 * boolean `--flag`. Deliberately tiny — the command framework will firm up against
 * Claude Code's own CLI practices (see docs/cli.md); this keeps the scaffold
 * dependency-free until then.
 */
export interface ParsedArgs {
  positionals: string[];
  options: Record<string, string | boolean>;
}

export function parseFlags(argv: string[]): ParsedArgs {
  const positionals: string[] = [];
  const options: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const body = a.slice(2);
      const eq = body.indexOf("=");
      if (eq >= 0) {
        options[body.slice(0, eq)] = body.slice(eq + 1);
      } else {
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith("--")) {
          options[body] = next;
          i++;
        } else {
          options[body] = true;
        }
      }
    } else {
      positionals.push(a);
    }
  }
  return { positionals, options };
}

/** Read a string option (returns undefined for missing or boolean flags). */
export function strOpt(opts: ParsedArgs["options"], key: string): string | undefined {
  const v = opts[key];
  return typeof v === "string" ? v : undefined;
}

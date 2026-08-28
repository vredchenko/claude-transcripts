/**
 * Projections from the CLI spec. Pure functions over `CliSpec` — no I/O, no Ink —
 * so the help screen, the pre-dispatch validator, and the docs generator all read
 * the same facts the same way. Nothing here knows which commands are implemented;
 * that's the registry's business (packages/cli/src/commands/index.ts).
 */
import type { CliArgDef, CliArgType, CliCommandDef, CliGroup, CliSpec } from "./types";

export const isFlag = (a: CliArgDef): boolean => a.name.startsWith("--");

/** Effective value type: explicit, else inferred from `choices`/`default`/shape. */
export function cliArgType(a: CliArgDef): CliArgType {
  if (a.type) return a.type;
  if (a.choices) return "string";
  if (typeof a.default === "number") return "number";
  if (typeof a.default === "string") return "string";
  return isFlag(a) ? "boolean" : "string";
}

export interface CliCommandGroup {
  key: CliGroup;
  title: string;
  commands: CliCommandDef[];
}

/** Commands bucketed by group, in the spec's group order (spec order within each). */
export function cliCommandsByGroup(spec: CliSpec): CliCommandGroup[] {
  return spec.groups
    .map((g) => ({ ...g, commands: spec.commands.filter((c) => c.group === g.key) }))
    .filter((g) => g.commands.length > 0);
}

/** `name <required> [optional]` — positionals only; flags are listed separately. */
export function cliUsage(cmd: CliCommandDef): string {
  const parts = (cmd.args ?? [])
    .filter((a) => !isFlag(a))
    .map((a) => (a.required ? `<${a.name}>` : `[${a.name}]`));
  const hasFlags = (cmd.args ?? []).some(isFlag);
  return [cmd.name, ...parts, ...(hasFlags ? ["[options]"] : [])].join(" ");
}

/** The parenthetical help appends to an arg's description: choices and default. */
export function cliArgHint(a: CliArgDef): string {
  const bits: string[] = [];
  if (a.choices) bits.push(a.choices.join(" | "));
  if (a.default !== undefined && a.default !== false) bits.push(`default ${a.default}`);
  return bits.length ? `(${bits.join("; ")})` : "";
}

/** How the value column reads in help/docs: `--limit <n>`, `--cwd <dir>`, `--force`. */
export function cliArgLabel(a: CliArgDef): string {
  if (!isFlag(a)) return a.name;
  switch (cliArgType(a)) {
    case "number":
      return `${a.name} <n>`;
    case "string":
      return `${a.name} <value>`;
    default:
      return a.name;
  }
}

// ── Validation ─────────────────────────────────────────────────────────────────

/** The shape the CLI's `parseFlags` produces — mirrored here so shared stays I/O-free. */
export interface ParsedCliArgs {
  positionals: string[];
  options: Record<string, string | boolean>;
}

/**
 * Check parsed argv against a command's spec. Reports every problem rather than the
 * first, so a script author fixes the invocation in one round trip.
 *
 * Deliberately checks only what the spec *knows*: unknown flags, values outside
 * `choices`, non-numbers where a number is declared, and missing required
 * positionals. Extra positionals are allowed (`stack logs <svc…>` takes a tail the spec
 * doesn't enumerate), and a flag's *presence* is never an error for a runner.
 */
export function validateCliArgs(
  spec: CliSpec,
  cmd: CliCommandDef,
  parsed: ParsedCliArgs,
): string[] {
  const errors: string[] = [];
  const args = cmd.args ?? [];
  const known = new Map<string, CliArgDef>();
  for (const a of [...spec.globalArgs, ...args]) if (isFlag(a)) known.set(a.name.slice(2), a);

  for (const [key, value] of Object.entries(parsed.options)) {
    const def = known.get(key);
    if (!def) {
      errors.push(`unknown option --${key}`);
      continue;
    }
    errors.push(...checkValue(def, value));
  }

  const positionals = args.filter((a) => !isFlag(a));
  positionals.forEach((def, i) => {
    const value = parsed.positionals[i];
    if (value === undefined) {
      if (def.required) errors.push(`missing required argument <${def.name}>`);
      return;
    }
    errors.push(...checkValue(def, value));
  });
  return errors;
}

function checkValue(def: CliArgDef, value: string | boolean): string[] {
  const type = cliArgType(def);
  const label = isFlag(def) ? def.name : `<${def.name}>`;
  if (typeof value === "boolean") {
    // `--limit` with no value: a value type was declared, so the flag alone is a mistake.
    return type === "boolean" ? [] : [`${label} needs a value`];
  }
  if (type === "boolean") return [`${label} takes no value (got "${value}")`];
  if (def.choices && !def.choices.includes(value)) {
    return [`${label} must be one of ${def.choices.join(" | ")} (got "${value}")`];
  }
  if (type === "number" && !/^-?\d+(\.\d+)?$/.test(value)) {
    return [`${label} must be a number (got "${value}")`];
  }
  return [];
}

// ── Docs ───────────────────────────────────────────────────────────────────────

const code = (s: string) => `\`${s.replace(/\|/g, "\\|")}\``;

/**
 * The command reference as GitHub-flavoured Markdown: one table per group, the global
 * options, and — with `detail` — a section per command with its arguments, options
 * and examples. Spliced into `packages/cli/README.md` (summary) and
 * `docs/reference/cli.md` (detail) by scripts/gen-cli-docs.ts.
 *
 * `bin` is how the binary is invoked in examples (`claude-transcripts`).
 */
export function toCliDocs(spec: CliSpec, bin: string, detail = true): string {
  const out: string[] = [];
  for (const g of cliCommandsByGroup(spec)) {
    out.push(`**${g.title}**`, "", "| Command | What it does |", "|---|---|");
    for (const c of g.commands) out.push(`| ${code(cliUsage(c))} | ${c.summary} |`);
    out.push("");
  }

  out.push("**Global options** (every command)", "");
  for (const a of spec.globalArgs) out.push(`- ${code(cliArgLabel(a))} — ${a.description ?? ""}`);
  out.push("");
  if (!detail) return out.join("\n").trimEnd();

  for (const g of cliCommandsByGroup(spec)) {
    for (const c of g.commands) {
      out.push(`### ${code(cliUsage(c))}`, "", c.summary, "");
      const positionals = (c.args ?? []).filter((a) => !isFlag(a));
      const flags = (c.args ?? []).filter(isFlag);
      if (positionals.length) {
        out.push("| Argument | |", "|---|---|");
        for (const a of positionals) out.push(`| ${code(a.name)} | ${describe(a)} |`);
        out.push("");
      }
      if (flags.length) {
        out.push("| Option | |", "|---|---|");
        for (const a of flags) out.push(`| ${code(cliArgLabel(a))} | ${describe(a)} |`);
        out.push("");
      }
      if (c.examples?.length) {
        out.push("```bash");
        for (const e of c.examples) out.push(`${bin} ${e}`);
        out.push("```", "");
      }
    }
  }
  return out.join("\n").trimEnd();
}

function describe(a: CliArgDef): string {
  const hint = cliArgHint(a);
  const req = !isFlag(a) && a.required ? "required. " : "";
  return `${req}${a.description ?? ""}${hint ? ` ${hint}` : ""}`.trim().replace(/\|/g, "\\|");
}

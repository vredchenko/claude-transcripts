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

// ── Completions ────────────────────────────────────────────────────────────────

export const COMPLETION_SHELLS = ["bash", "zsh", "fish"] as const;
export type CompletionShell = (typeof COMPLETION_SHELLS)[number];

/**
 * A shell completion script for `bin`, printed by `claude-transcripts completions
 * <shell>` for the user to `eval` or source. What it completes, in every shell:
 *
 *   - the command name, then the command's flags plus the global ones;
 *   - a positional with `choices` (`stack <action>`) to those values;
 *   - a flag that takes a value (`type` string/number, or `choices`) to its choices if
 *     it has any, else to nothing — the next word is that flag's, not a new argument;
 *   - a positional without `choices` to nothing: the spec can't tell a session id from
 *     a directory, and offering filenames for an id would be worse than silence.
 *
 * Valued flags are skipped when counting positionals, mirroring `parseFlags`, so
 * `stack --webapi http://x <TAB>` still offers the actions. Generated, so it can't drift
 * from the binary; no I/O, so it's snapshot-tested per shell.
 */
export function toCompletions(spec: CliSpec, shell: CompletionShell, bin: string): string {
  const fn = `_${bin.replace(/[^A-Za-z0-9]/g, "_")}`;
  switch (shell) {
    case "bash":
      return bashCompletions(spec, bin, fn);
    case "zsh":
      return zshCompletions(spec, bin, fn);
    case "fish":
      return fishCompletions(spec, bin, fn);
  }
}

const takesValue = (a: CliArgDef): boolean => isFlag(a) && cliArgType(a) !== "boolean";
const flagsOf = (c: CliCommandDef): CliArgDef[] => (c.args ?? []).filter(isFlag);
const positionalsOf = (c: CliCommandDef): CliArgDef[] => (c.args ?? []).filter((a) => !isFlag(a));
const header = (shell: string, bin: string) =>
  `# ${shell} completion for ${bin} — generated from CLI_SPEC; do not edit.`;

/** `cmd:--flag` keys for every valued flag (global ones as `*:--flag`). */
function valuedKeys(spec: CliSpec): string[] {
  return [
    ...spec.globalArgs.filter(takesValue).map((a) => `*:${a.name}`),
    ...spec.commands.flatMap((c) =>
      flagsOf(c)
        .filter(takesValue)
        .map((a) => `${c.name}:${a.name}`),
    ),
  ];
}

function bashCompletions(spec: CliSpec, bin: string, fn: string): string {
  const globals = spec.globalArgs.map((a) => a.name).join(" ");
  const commands = spec.commands.map((c) => c.name).join(" ");
  const flagCases = spec.commands
    .map(
      (c) =>
        `    ${c.name}) flags="${flagsOf(c)
          .map((a) => a.name)
          .join(" ")}" ;;`,
    )
    .join("\n");
  const choiceCases = [
    ...spec.globalArgs.filter((a) => a.choices).map((a) => [`*:${a.name}`, a.choices] as const),
    ...spec.commands.flatMap((c) => [
      ...flagsOf(c)
        .filter((a) => a.choices)
        .map((a) => [`${c.name}:${a.name}`, a.choices] as const),
      ...positionalsOf(c).flatMap((a, i) =>
        a.choices ? [[`${c.name}:${i + 1}`, a.choices] as const] : [],
      ),
    ]),
  ]
    .map(([k, v]) => `    ${k}) choices="${v?.join(" ")}" ;;`)
    .join("\n");
  const valued = valuedKeys(spec);

  return `${header("bash", bin)}
# Load it with:  eval "$(${bin} completions bash)"   (e.g. in ~/.bashrc)

# Does flag $2 take a value under command $1 (empty before the command)?
${fn}_valued() {
  case "$1:$2" in
    ${valued.length ? `${valued.join("|")}) return 0 ;;` : ""}
  esac
  return 1
}

# Values to offer for key $1 — \`cmd:--flag\` or \`cmd:<positional index>\`.
${fn}_choices() {
  local choices=""
  case "$1" in
${choiceCases}
  esac
  printf '%s' "$choices"
}

${fn}() {
  local cur="\${COMP_WORDS[COMP_CWORD]}" cmd="" npos=0 i w flag="" flags=""
  COMPREPLY=()
  # Walk the words before the cursor: find the command, count its positionals, and
  # note whether the word being completed is the value of a valued flag. Bash splits
  # \`--flag=value\` into \`--flag\`, \`=\`, \`value\`, hence the "=" handling.
  for ((i = 1; i < COMP_CWORD; i++)); do
    w="\${COMP_WORDS[i]}"
    if [[ -n $flag ]]; then
      [[ $w == "=" ]] && continue
      flag=""
      continue
    fi
    case "$w" in
      -*) ${fn}_valued "$cmd" "$w" && flag="$w" ;;
      "=") ;;
      *) if [[ -z $cmd ]]; then cmd="$w"; else npos=$((npos + 1)); fi ;;
    esac
  done
  [[ $cur == "=" ]] && cur=""

  if [[ -n $flag ]]; then
    local key="$cmd:$flag"
    [[ -z $cmd ]] && key="*:$flag"
    local choices
    choices="$(${fn}_choices "$key")"
    [[ -z $choices ]] && choices="$(${fn}_choices "*:$flag")"
    [[ -n $choices ]] && mapfile -t COMPREPLY < <(compgen -W "$choices" -- "$cur")
    return 0
  fi

  if [[ -z $cmd ]]; then
    if [[ $cur == -* ]]; then
      mapfile -t COMPREPLY < <(compgen -W "${globals}" -- "$cur")
    else
      mapfile -t COMPREPLY < <(compgen -W "${commands}" -- "$cur")
    fi
    return 0
  fi

  if [[ $cur == -* ]]; then
    case "$cmd" in
${flagCases}
    esac
    mapfile -t COMPREPLY < <(compgen -W "$flags ${globals}" -- "$cur")
    return 0
  fi

  local choices
  choices="$(${fn}_choices "$cmd:$((npos + 1))")"
  [[ -n $choices ]] && mapfile -t COMPREPLY < <(compgen -W "$choices" -- "$cur")
  return 0
}

complete -F ${fn} ${bin}
`;
}

/** Text inside an `_arguments` `[description]`, single-quoted in the script. */
const zshDesc = (s: string) =>
  s
    .replace(/\\/g, "\\\\")
    .replace(/([[\]:])/g, "\\$1")
    .replace(/'/g, "'\\''");

/** An `_arguments` spec for a flag: `'--json[desc]'`, `'--limit=[desc]:n: '`. */
function zshFlagSpec(a: CliArgDef): string {
  const desc = zshDesc(a.description ?? "");
  if (!takesValue(a)) return `'${a.name}[${desc}]'`;
  const label = cliArgType(a) === "number" ? "n" : "value";
  return `'${a.name}=[${desc}]:${label}:${zshAction(a)}'`;
}

/** Complete to `choices`, else nothing (a space: no matches, but no error either). */
const zshAction = (a: CliArgDef) => (a.choices ? `(${a.choices.join(" ")})` : " ");

function zshCompletions(spec: CliSpec, bin: string, fn: string): string {
  const indent = (n: number) => " ".repeat(n);
  const globals = spec.globalArgs.map((a) => `${indent(4)}${zshFlagSpec(a)}`).join("\n");
  const commands = spec.commands
    .map((c) => `${indent(4)}'${c.name.replace(/:/g, "\\:")}:${zshDesc(c.summary)}'`)
    .join("\n");
  const cases = spec.commands
    .map((c) => {
      const specs = [
        ...positionalsOf(c).map((a, i) => `'${i + 1}:${a.name}:${zshAction(a)}'`),
        ...flagsOf(c).map(zshFlagSpec),
        // Extra positionals (`stack logs <svc…>`) are allowed, so don't reject them.
        "'*: : '",
      ];
      return [
        `${indent(8)}(${c.name})`,
        `${indent(10)}_arguments -S $globals \\`,
        ...specs.map((s, i) => `${indent(12)}${s}${i < specs.length - 1 ? " \\" : ""}`),
        `${indent(10)};;`,
      ].join("\n");
    })
    .join("\n");

  return `#compdef ${bin}
${header("zsh", bin)}
# Load it with:  eval "$(${bin} completions zsh)"   (after compinit, e.g. in ~/.zshrc)
# or save it as \`${fn}\` in a directory on $fpath.

${fn}() {
  local curcontext="$curcontext" state line
  local -a globals commands
  globals=(
${globals}
  )
  commands=(
${commands}
  )

  _arguments -C -S $globals '1: :->command' '*:: :->args' && return 0

  case $state in
    (command)
      _describe -t commands '${bin} command' commands
      ;;
    (args)
      case $words[1] in
${cases}
      esac
      ;;
  esac
}

if [[ $zsh_eval_context[-1] == loadautofunc ]]; then
  ${fn} "$@"
else
  compdef ${fn} ${bin}
fi
`;
}

/** A fish single-quoted string. */
const fishQ = (s: string) => `'${s.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;

function fishCompletions(spec: CliSpec, bin: string, fn: string): string {
  const c = `complete -c ${bin}`;
  const valued = valuedKeys(spec)
    .map((k) => fishQ(k))
    .join(" ");
  const flagLine = (cond: string | undefined, a: CliArgDef) => {
    const parts = [c];
    if (cond) parts.push("-n", fishQ(cond));
    parts.push("-l", a.name.slice(2));
    if (takesValue(a)) parts.push(a.choices ? `-xa ${fishQ(a.choices.join(" "))}` : "-x");
    if (a.description) parts.push("-d", fishQ(a.description));
    return parts.join(" ");
  };

  const lines: string[] = [];
  for (const cmd of spec.commands) {
    lines.push(`${c} -n '${fn}_at_command' -a ${cmd.name} -d ${fishQ(cmd.summary)}`);
  }
  lines.push("");
  for (const a of spec.globalArgs) lines.push(flagLine(undefined, a));
  for (const cmd of spec.commands) {
    const pos = positionalsOf(cmd);
    const flags = flagsOf(cmd);
    if (!pos.some((a) => a.choices) && flags.length === 0) continue;
    lines.push("");
    pos.forEach((a, i) => {
      if (!a.choices) return;
      lines.push(
        `${c} -n '${fn}_at_positional ${cmd.name} ${i + 1}' -a ${fishQ(a.choices.join(" "))}`,
      );
    });
    for (const a of flags) lines.push(flagLine(`${fn}_in ${cmd.name}`, a));
  }

  return `${header("fish", bin)}
# Load it with:  ${bin} completions fish | source   (e.g. in ~/.config/fish/config.fish)
# or save it as ~/.config/fish/completions/${bin}.fish

# Does flag $argv[2] take a value under command $argv[1] (empty before the command)?
function ${fn}_valued
    switch "$argv[1]:$argv[2]"
        case ${valued}
            return 0
    end
    return 1
end

# The non-option words before the cursor (command first), skipping valued flags' values.
function ${fn}_words
    set -l tokens (commandline -opc)
    set -e tokens[1]
    set -l out
    set -l skip 0
    for t in $tokens
        if test $skip = 1
            set skip 0
            continue
        end
        switch $t
            case '--*=*'
            case '-*'
                ${fn}_valued "$out[1]" $t; and set skip 1
            case '*'
                set -a out $t
        end
    end
    # A bare \`printf\` with no words still prints one empty line, which would count.
    test (count $out) -gt 0; and printf '%s\\n' $out
end

function ${fn}_at_command
    test (count (${fn}_words)) -eq 0
end

function ${fn}_in
    set -l w (${fn}_words)
    test "$w[1]" = "$argv[1]"
end

function ${fn}_at_positional
    set -l w (${fn}_words)
    test "$w[1]" = "$argv[1]"; and test (count $w) -eq $argv[2]
end

${c} -f
${lines.join("\n")}
`;
}

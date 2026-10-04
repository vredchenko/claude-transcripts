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
 * <shell>` for the user to `eval` or source. It offers only what the CLI will accept,
 * so it follows the dispatcher and `parseFlags`, not an idealised grammar:
 *
 *   - the command is the first word, and only the first (cli.tsx): before it, command
 *     names and the boolean global flags; after a leading flag, nothing;
 *   - after the command, its flags plus the global ones, and a positional's `choices`;
 *   - a bare `--flag` takes the next word as its value unless that word is another
 *     `--flag`, whatever the flag's declared type (`parseFlags`). After a valued flag
 *     that word completes to its `choices`, else to nothing; after a boolean flag, to
 *     flags only, since a positional there would be read as the flag's value and
 *     rejected;
 *   - a positional without `choices` completes to nothing: the spec can't tell a
 *     session id from a directory, and offering filenames for an id would be worse.
 *
 * Generated, so it can't drift from the binary; no I/O, so it's snapshot-tested.
 */
export function toCompletions(spec: CliSpec, shell: CompletionShell, bin: string): string {
  const model = completionModel(spec);
  const fn = `_${bin.replace(/[^A-Za-z0-9]/g, "_")}`;
  switch (shell) {
    case "bash":
      return bashCompletions(model, bin, fn);
    case "zsh":
      return zshCompletions(model, bin, fn);
    case "fish":
      return fishCompletions(model, bin, fn);
  }
}

const takesValue = (a: CliArgDef): boolean => isFlag(a) && cliArgType(a) !== "boolean";

/** The facts every shell's script is written from. Keys are `cmd:--flag` / `cmd:<n>`. */
interface CompletionModel {
  commands: CliCommandDef[];
  /** Flags that work before a command: the boolean globals (`--help`, `--version`). */
  leading: CliArgDef[];
  /** A command's flags, then the global ones (every global applies after a command). */
  flags: Map<string, CliArgDef[]>;
  valued: string[];
  choices: [key: string, values: readonly string[]][];
}

function completionModel(spec: CliSpec): CompletionModel {
  const flags = new Map<string, CliArgDef[]>();
  const valued: string[] = [];
  const choices: [string, readonly string[]][] = [];
  for (const c of spec.commands) {
    const all = [...(c.args ?? []).filter(isFlag), ...spec.globalArgs.filter(isFlag)];
    flags.set(c.name, all);
    for (const a of all) {
      if (!takesValue(a)) continue;
      valued.push(`${c.name}:${a.name}`);
      if (a.choices) choices.push([`${c.name}:${a.name}`, a.choices]);
    }
    (c.args ?? [])
      .filter((a) => !isFlag(a))
      .forEach((a, i) => {
        if (a.choices) choices.push([`${c.name}:${i + 1}`, a.choices]);
      });
  }
  const leading = spec.globalArgs.filter((a) => isFlag(a) && !takesValue(a));
  return { commands: spec.commands, leading, flags, valued, choices };
}

const header = (shell: string, bin: string) =>
  `# ${shell} completion for ${bin} — generated from CLI_SPEC; do not edit.`;
const names = (args: CliArgDef[]) => args.map((a) => a.name).join(" ");

function bashCompletions(m: CompletionModel, bin: string, fn: string): string {
  const flagCases = m.commands
    .map((c) => `    ${c.name}) printf '%s' "${names(m.flags.get(c.name) ?? [])}" ;;`)
    .join("\n");
  const choiceCases = m.choices
    .map(([k, v]) => `    ${k}) printf '%s' "${v.join(" ")}" ;;`)
    .join("\n");

  return `${header("bash", bin)}
# Load it with:  eval "$(${bin} completions bash)"   (e.g. in ~/.bashrc)
# Works with bash 3.2+ and needs no bash-completion package.

# Does flag \`cmd:--flag\` ($1) take a value?
${fn}_valued() {
  case "$1" in
    ${m.valued.length ? `${m.valued.join("|")}) return 0 ;;` : ""}
  esac
  return 1
}

# The values to offer for $1 — \`cmd:--flag\` or \`cmd:<positional index>\`.
${fn}_choices() {
  case "$1" in
${choiceCases}
  esac
}

# The flags command $1 accepts, its own and the global ones.
${fn}_flags() {
  case "$1" in
${flagCases}
  esac
}

${fn}() {
  # Split the line ourselves: COMP_WORDS also breaks at ":" and "=", which would turn
  # \`--webapi http://x\` into four words and miscount everything after it.
  local line="\${COMP_LINE:0:COMP_POINT}" cur cmd npos=0 flag="" i n w
  local -a words
  read -ra words <<<"$line"
  [[ $line == *[[:space:]] || \${#words[@]} -eq 0 ]] && words+=("")
  n=\${#words[@]}
  cur="\${words[n - 1]}"
  COMPREPLY=()
  # \`--flag=value\`: bash replaces only the part after "=", which compgen can't target.
  [[ $cur == *=* ]] && return 0

  if ((n == 2)); then
    if [[ $cur == -* ]]; then
      COMPREPLY=($(compgen -W "${names(m.leading)}" -- "$cur"))
    else
      COMPREPLY=($(compgen -W "${m.commands.map((c) => c.name).join(" ")}" -- "$cur"))
    fi
    return 0
  fi

  # Only the first word is the command; after a leading flag nothing runs a command.
  cmd="\${words[1]}"
  [[ $cmd == -* ]] && return 0

  # Count positionals the way parseFlags reads them: a bare --flag takes the next word
  # as its value unless that word is another --flag.
  for ((i = 2; i < n - 1; i++)); do
    w="\${words[i]}"
    if [[ -n $flag && $w != --* ]]; then
      flag=""
      continue
    fi
    flag=""
    case "$w" in
      --*=*) ;;
      --*) flag="$w" ;;
      *) npos=$((npos + 1)) ;;
    esac
  done

  if [[ -n $flag ]] && ${fn}_valued "$cmd:$flag"; then
    COMPREPLY=($(compgen -W "$(${fn}_choices "$cmd:$flag")" -- "$cur"))
  elif [[ $cur == -* || -n $flag ]]; then
    COMPREPLY=($(compgen -W "$(${fn}_flags "$cmd")" -- "$cur"))
  else
    COMPREPLY=($(compgen -W "$(${fn}_choices "$cmd:$((npos + 1))")" -- "$cur"))
  fi
  return 0
}

complete -F ${fn} ${bin}
`;
}

/** A single-quoted zsh word. */
const zshQ = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;
/** A `_describe` entry: `name:description`, with colons in the name escaped. */
const zshEntry = (name: string, desc = "") => zshQ(`${name.replace(/:/g, "\\:")}:${desc}`);

function zshCompletions(m: CompletionModel, bin: string, fn: string): string {
  const entries = (args: CliArgDef[]) => args.map((a) => zshEntry(a.name, a.description)).join(" ");
  const flagCases = m.commands
    .map((c) => `    (${c.name}) reply=(${entries(m.flags.get(c.name) ?? [])}) ;;`)
    .join("\n");
  const choiceCases = m.choices.map(([k, v]) => `    (${k}) reply=(${v.join(" ")}) ;;`).join("\n");
  const commands = m.commands.map((c) => `    ${zshEntry(c.name, c.summary)}`).join("\n");

  return `#compdef ${bin}
${header("zsh", bin)}
# Load it with:  eval "$(${bin} completions zsh)"   (after compinit, e.g. in ~/.zshrc)
# or save it as \`${fn}\` in a directory on $fpath.

${fn}_valued() {
  case $1 in
    (${m.valued.join("|")}) return 0 ;;
  esac
  return 1
}

${fn}_choices() {
  reply=()
  case $1 in
${choiceCases}
  esac
}

${fn}_flags() {
  reply=()
  case $1 in
${flagCases}
  esac
}

${fn}() {
  local cur=$words[CURRENT] cmd=$words[2] npos=0 flag="" i w
  local -a reply commands
  commands=(
${commands}
  )

  if (( CURRENT == 2 )); then
    if [[ $cur == -* ]]; then
      reply=(${entries(m.leading)})
      _describe -t options option reply
    else
      _describe -t commands '${bin} command' commands
    fi
    return
  fi

  # Only the first word is the command; after a leading flag nothing runs a command.
  [[ $cmd == -* ]] && return 1

  # Count positionals the way parseFlags reads them: a bare --flag takes the next word
  # as its value unless that word is another --flag.
  for (( i = 3; i < CURRENT; i++ )); do
    w=$words[i]
    if [[ -n $flag && $w != --* ]]; then
      flag=""
      continue
    fi
    flag=""
    case $w in
      (--*=*) ;;
      (--*) flag=$w ;;
      (*) npos=$((npos + 1)) ;;
    esac
  done

  if [[ $cur == --*=* ]]; then
    flag=\${cur%%=*}
    ${fn}_valued "$cmd:$flag" || return 1
    compset -P '*='
  fi

  if [[ -n $flag ]] && ${fn}_valued "$cmd:$flag"; then
    ${fn}_choices "$cmd:$flag"
    if (( $#reply )); then compadd -a reply; else _message value; fi
  elif [[ $cur == -* || -n $flag ]]; then
    ${fn}_flags "$cmd"
    _describe -t options option reply
  else
    ${fn}_choices "$cmd:$((npos + 1))"
    (( $#reply )) && compadd -a reply
  fi
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

function fishCompletions(m: CompletionModel, bin: string, fn: string): string {
  const c = `complete -c ${bin}`;
  const flagLine = (cond: string, a: CliArgDef, cmd?: string) => {
    const parts = [c, "-n", fishQ(cond), "-l", a.name.slice(2)];
    if (takesValue(a)) {
      const ch = m.choices.find(([k]) => k === `${cmd}:${a.name}`)?.[1];
      parts.push(ch ? `-xa ${fishQ(ch.join(" "))}` : "-x");
    }
    if (a.description) parts.push("-d", fishQ(a.description));
    return parts.join(" ");
  };

  const lines: string[] = [];
  for (const cmd of m.commands) {
    lines.push(`${c} -n ${fn}_at_command -a ${cmd.name} -d ${fishQ(cmd.summary)}`);
  }
  for (const a of m.leading) lines.push(flagLine(`${fn}_at_command`, a));
  for (const cmd of m.commands) {
    lines.push("");
    for (const [key, values] of m.choices) {
      const [name, pos] = key.split(":");
      if (name !== cmd.name || pos?.startsWith("--")) continue;
      lines.push(`${c} -n '${fn}_at_positional ${cmd.name} ${pos}' -a ${fishQ(values.join(" "))}`);
    }
    for (const a of m.flags.get(cmd.name) ?? [])
      lines.push(flagLine(`${fn}_in ${cmd.name}`, a, cmd.name));
  }

  return `${header("fish", bin)}
# Load it with:  ${bin} completions fish | source   (e.g. in ~/.config/fish/config.fish)
# or save it as ~/.config/fish/completions/${bin}.fish

# Nothing typed after the binary yet: the next word is the command.
function ${fn}_at_command
    test (count (commandline -opc)) -eq 1
end

# The command (the first word, and only the first) is $argv[1].
function ${fn}_in
    set -l t (commandline -opc)
    test "$t[2]" = "$argv[1]"
end

# The word being completed is positional $argv[2] of command $argv[1]. Positionals
# are counted the way parseFlags reads them: a bare --flag takes the next word as its
# value unless that word is another --flag.
function ${fn}_at_positional
    set -l t (commandline -opc)
    test "$t[2]" = "$argv[1]"; or return 1
    set -l npos 0
    set -l flag 0
    for w in $t[3..-1]
        if test $flag = 1; and not string match -q -- '--*' $w
            set flag 0
            continue
        end
        set flag 0
        switch $w
            case '--*=*'
            case '--*'
                set flag 1
            case '*'
                set npos (math $npos + 1)
        end
    end
    test $flag = 0; and test $npos -eq (math $argv[2] - 1)
end

${c} -f
${lines.join("\n")}
`;
}

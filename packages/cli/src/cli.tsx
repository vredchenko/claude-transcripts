#!/usr/bin/env bun
/**
 * claude-transcripts — the user-facing CLI (and admin utility) for Claude Transcripts.
 * Built with Ink (React for CLIs), the same stack Claude Code uses.
 *
 * Aggregate of internal modules (docs/reference/cli.md): a generated webapi client, a
 * `.claude/` reader/parser, hooks-setup, and import/export — composed under one
 * command surface.
 *
 * Dispatch order, and what each outcome costs a caller:
 *
 *   --version / -V          → the version on stdout, exit 0
 *   --help / -h, no command → the Ink help on stdout, exit 0
 *   unknown command         → help + "unknown command" on STDERR, exit 2
 *   bad arguments           → the errors + usage on STDERR, exit 2
 *   a command               → its runner's exit code
 *
 * Exit 2 is "usage error", as in every getopt-shaped tool, so a script can tell a typo
 * (2) from a command that ran and failed (1). Both are rendered from CLI_SPEC — one
 * source of truth — and validated against it before any runner sees argv, which is
 * why `stack blah` no longer reaches `stack`.
 */
import { CLI_SPEC, cliUsage, validateCliArgs } from "@claude-transcripts/shared";
import { render } from "ink";
import { App } from "./app";
import { COMMANDS } from "./commands";
import { parseFlags } from "./lib/args";
import { VERSION } from "./lib/version";

const [, , first, ...rest] = process.argv;

const USAGE_ERROR = 2;

/**
 * Render the help UI to `stream`. Ink writes the first frame synchronously, so once
 * `render` returns the text is out; unmounting releases stdin so the process can exit.
 */
function showHelp(props: Parameters<typeof App>[0], stream: NodeJS.WriteStream = process.stdout) {
  render(<App {...props} />, { stdout: stream, exitOnCtrlC: false, patchConsole: false }).unmount();
}

const argv = first === undefined ? [] : [first, ...rest];
if (argv.includes("--version") || argv.includes("-V")) {
  console.log(VERSION);
  process.exit(0);
}

// A leading flag (`claude-transcripts --help`) is not a command name.
const command = first !== undefined && !first.startsWith("-") ? first : undefined;
const args = command === undefined ? argv : rest;

// `--help` is handled here, before dispatch, because the commands don't parse it and
// their flag parser treats any unknown `--flag` as a harmless boolean. That meant
// `backfill --help` *ran the backfill* — asking a write command for usage and having it
// write instead. Intercepting turns it into the help screen for that command.
const wantsHelp = args.includes("--help") || args.includes("-h");

if (command === undefined) {
  showHelp({});
  process.exit(0);
}

const spec = CLI_SPEC.commands.find((c) => c.name === command);
const runner = COMMANDS[command];

if (!spec || !runner) {
  // The registry is the fact: a command the spec lists but nothing implements is just
  // as unknown to the caller as a typo, and `index.test.ts` keeps the two lists equal.
  showHelp({ unknown: command }, process.stderr);
  process.exit(USAGE_ERROR);
}

if (wantsHelp) {
  showHelp({ command });
  process.exit(0);
}

const errors = validateCliArgs(CLI_SPEC, spec, parseFlags(args));
if (errors.length > 0) {
  for (const e of errors) console.error(`${command}: ${e}`);
  console.error(`usage: claude-transcripts ${cliUsage(spec)}   (--help for details)`);
  process.exit(USAGE_ERROR);
}

process.exit(await runner(args));

#!/usr/bin/env bun
/**
 * claude-transcripts — the user-facing CLI (and admin utility) for Claude Code Sessions
 * History. Built with Ink (React for CLIs), the same stack Claude Code uses.
 *
 * Aggregate of internal modules (docs/reference/cli.md): a generated webapi client, a
 * `.claude/` reader/parser, hooks-setup, and import/export — composed under one
 * command surface. The command framework will firm up against the Claude Code
 * codebase's practices.
 *
 * Dispatch: non-interactive data commands run via the COMMANDS registry; anything
 * else renders the Ink help UI (rendered from CLI_SPEC — one source of truth).
 */
import { render } from "ink";
import { App } from "./app";
import { COMMANDS } from "./commands";

const [, , command, ...args] = process.argv;

// `--help` is handled here, before dispatch, because the commands don't parse it and
// their flag parser treats any unknown `--flag` as a harmless boolean. That meant
// `backfill --help` *ran the backfill* — asking a write command for usage and having it
// write instead. Intercepting turns it into the help screen for that command.
const wantsHelp = args.includes("--help") || args.includes("-h");

const runner = command && !wantsHelp ? COMMANDS[command] : undefined;
if (runner) {
  process.exit(await runner(args));
} else {
  render(<App command={command} args={args} />);
}

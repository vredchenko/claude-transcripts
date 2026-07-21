#!/usr/bin/env bun
/**
 * claude-transcripts — the user-facing CLI (and admin utility) for Claude Code Sessions
 * History. Built with Ink (React for CLIs), the same stack Claude Code uses.
 *
 * Aggregate of internal modules (docs/cli.md): a generated webapi client, a
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

const runner = command ? COMMANDS[command] : undefined;
if (runner) {
  process.exit(await runner(args));
} else {
  render(<App command={command} args={args} />);
}

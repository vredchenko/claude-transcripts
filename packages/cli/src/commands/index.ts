/**
 * Runnable (non-interactive) command registry. cli.tsx dispatches to these for
 * batch/data operations; commands NOT listed here fall through to the Ink help UI
 * (app.tsx). A runner takes the post-command argv and returns a process exit code.
 *
 * Keep names in step with CLI_SPEC (@claude-transcripts/shared model) — that's what renders
 * help. As more data-lifecycle commands land (reconcile, export, import, migrate),
 * register them here.
 */
import { runBackfill } from "./backfill";
import { runDoctor } from "./doctor";
import { runMigrate } from "./migrate";
import { runSessions } from "./sessions";
import { runSetup } from "./setup";

export type CommandRunner = (argv: string[]) => Promise<number>;

export const COMMANDS: Record<string, CommandRunner> = {
  setup: runSetup,
  backfill: runBackfill,
  migrate: runMigrate,
  doctor: runDoctor,
  sessions: runSessions,
};

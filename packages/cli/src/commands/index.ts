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
import { runExport } from "./export";
import { runHook } from "./hook";
import { runImport } from "./import";
import { runInstall } from "./install";
import { runMigrate } from "./migrate";
import { runProvision } from "./provision";
import { runReindex } from "./reindex";
import { runSearch } from "./search";
import { runSessions } from "./sessions";
import { runSetup } from "./setup";
import { runStack } from "./stack";
import { runStatusline } from "./statusline";
import { runUninstall } from "./uninstall";

export type CommandRunner = (argv: string[]) => Promise<number>;

export const COMMANDS: Record<string, CommandRunner> = {
  install: runInstall,
  uninstall: runUninstall,
  stack: runStack,
  provision: runProvision,
  hook: runHook,
  statusline: runStatusline,
  export: runExport,
  import: runImport,
  setup: runSetup,
  backfill: runBackfill,
  migrate: runMigrate,
  reindex: runReindex,
  doctor: runDoctor,
  sessions: runSessions,
  search: runSearch,
};

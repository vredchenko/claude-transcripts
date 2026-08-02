/**
 * `claude-transcripts stack` — the container stack for an installed instance.
 *
 *   claude-transcripts stack up|down|restart|logs|ps [--app] [--volumes]
 *
 * The user-facing counterpart to `scripts/stack.ts` (dev-only, repo-rooted): same
 * compose topology, but driven from the instance layout — assets written out of the
 * binary, and the generated instance env as `--env-file`.
 */
import { existsSync } from "node:fs";
import { parseFlags } from "../lib/args";
import { compose, composeDown, composeLogs, composePs, composeUp } from "../lib/compose";
import { loadOrCreateInstanceEnv } from "../lib/instance-env";
import { installPaths } from "../lib/paths";

export async function runStack(argv: string[]): Promise<number> {
  const { positionals, options } = parseFlags(argv);
  const cmd = positionals[0] ?? "ps";
  const paths = installPaths();

  if (!existsSync(paths.instanceEnv)) {
    console.error("stack: this machine has no instance — run `claude-transcripts install` first.");
    return 1;
  }
  const env = loadOrCreateInstanceEnv(paths.instanceEnv);
  const app = options.app === true;
  const opts = { paths, env, app };

  try {
    switch (cmd) {
      case "up":
        await composeUp(opts);
        return 0;
      case "down":
        // `--volumes` is the destructive one: it deletes the stores, not just the
        // containers. Never implied by a plain `down`.
        await composeDown(opts, options.volumes === true);
        return 0;
      case "restart":
        await compose(opts, ["restart"]);
        return 0;
      case "logs":
        await composeLogs(opts, positionals.slice(1));
        return 0;
      case "ps":
        await composePs(opts);
        return 0;
      default:
        console.error(`stack: unknown subcommand "${cmd}" (up | down | restart | logs | ps)`);
        return 2;
    }
  } catch (err) {
    console.error(`stack: ${(err as Error).message}`);
    return 1;
  }
}

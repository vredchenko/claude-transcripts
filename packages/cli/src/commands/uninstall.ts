/**
 * `claude-transcripts uninstall` — remove the instance.
 *
 *   claude-transcripts uninstall [--purge] [--yes]
 *
 * Deregisters the hook, stops the stack, and removes the generated config and written
 * assets. **History survives** — it lives in Docker volumes, and losing it to a
 * routine uninstall would be unforgivable. `--purge` deletes the volumes too, and only
 * with an explicit confirmation.
 *
 * Every step tolerates already being done, so this works on a half-installed instance
 * (which is exactly when someone reaches for it).
 */
import { existsSync, rmSync } from "node:fs";
import { parseFlags } from "../lib/args";
import { composeDown } from "../lib/compose";
import { loadOrCreateInstanceEnv } from "../lib/instance-env";
import { installPaths } from "../lib/paths";
import { runHook } from "./hook";

async function confirmPurge(auto: boolean): Promise<boolean> {
  if (auto) return true;
  process.stdout.write(
    "\nuninstall: --purge DELETES ALL RECORDED HISTORY (CouchDB + S3 volumes).\n" +
      "Type 'delete my history' to confirm: ",
  );
  const line = (await new Response(Bun.stdin.stream()).text()).trim();
  return line === "delete my history";
}

export async function runUninstall(argv: string[]): Promise<number> {
  const { options } = parseFlags(argv);
  const purge = options.purge === true;
  const paths = installPaths();

  if (purge && !(await confirmPurge(options.yes === true))) {
    console.error("uninstall: not confirmed — nothing was removed.");
    return 1;
  }

  console.log("uninstall: deregistering the hook");
  await runHook(["uninstall"]);

  if (existsSync(paths.instanceEnv)) {
    console.log(`uninstall: stopping the stack${purge ? " and deleting volumes" : ""}`);
    try {
      const env = loadOrCreateInstanceEnv(paths.instanceEnv);
      await composeDown({ paths, env, app: true }, purge);
    } catch (err) {
      // A stack that's already gone (or a Docker that isn't running) must not stop us
      // cleaning up the rest.
      console.warn(`uninstall: could not stop the stack (continuing): ${(err as Error).message}`);
    }
  }

  for (const target of [paths.hookConfig, paths.instanceEnv, paths.deployDir, paths.versionFile]) {
    try {
      rmSync(target, { recursive: true, force: true });
    } catch {
      // already gone
    }
  }
  console.log("uninstall: removed generated config and deployment assets");

  if (purge) {
    rmSync(paths.appConfig, { force: true });
    console.log("uninstall: purged history and app config");
  } else {
    console.log(`uninstall: history kept in Docker volumes; ${paths.appConfig} left in place`);
    console.log("uninstall: re-run with --purge to delete the data too");
  }
  console.log(`uninstall: the binary itself is still at ${paths.binDir}/claude-transcripts`);
  return 0;
}

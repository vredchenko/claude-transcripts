/**
 * `claude-transcripts provision` — create the stores an instance needs.
 *
 *   claude-transcripts provision
 *
 * CouchDB databases and Garage's bucket + access key. Meilisearch needs nothing: the
 * webapi creates its indexes at boot, and `reindex` rebuilds them.
 *
 * Split out of `install` because it's the phase most likely to need re-running on its
 * own — it's the one that depends on the stack already being healthy, and Garage's
 * credentials only exist once Garage is up.
 */
import { existsSync } from "node:fs";
import { loadAppConfig } from "../lib/app-config";
import { loadOrCreateInstanceEnv } from "../lib/instance-env";
import { installPaths } from "../lib/paths";
import { provisionCouch, provisionGarage } from "../lib/provision";

export async function runProvision(_argv: string[]): Promise<number> {
  const paths = installPaths();
  if (!existsSync(paths.instanceEnv)) {
    console.error(
      "provision: this machine has no instance — run `claude-transcripts install` first.",
    );
    return 1;
  }
  const env = loadOrCreateInstanceEnv(paths.instanceEnv);
  const app = loadAppConfig();
  let ok = true;

  for (const s of await provisionCouch(env, Object.values(app.couchdb.databases))) {
    console.log(`  ${s.ok ? "✓" : "✗"} ${s.name}: ${s.detail}`);
    if (!s.ok) ok = false;
  }

  try {
    const bucket = app.s3.buckets.sessions ?? "claude-transcripts-sessions";
    const garage = await provisionGarage(env, bucket, paths.instanceEnv);
    for (const s of garage.steps) {
      console.log(`  ${s.ok ? "✓" : "✗"} ${s.name}: ${s.detail}`);
      if (!s.ok) ok = false;
    }
    if (ok) {
      console.log(
        "provision: done. If the app was already running, restart it so it picks up the S3 credentials:",
      );
      console.log("  claude-transcripts stack restart --app");
    }
  } catch (err) {
    console.error(`provision: ${(err as Error).message}`);
    return 1;
  }
  return ok ? 0 : 1;
}

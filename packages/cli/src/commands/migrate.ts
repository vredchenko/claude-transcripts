/**
 * `claude-transcripts migrate <up|down|status>` — drive the self-built CouchDB
 * migration engine (ADR 0021) through the webapi. The engine itself lives in
 * `@claude-transcripts/shared`; the webapi runs it (I/O gateway), and this command is the
 * user-facing driver.
 *
 *   claude-transcripts migrate status
 *   claude-transcripts migrate up   [--to <version>] [--dry-run]
 *   claude-transcripts migrate down [--steps <n>]    [--dry-run]
 *   (all accept --webapi <url>)
 */
import type { MigrationRunResponse } from "../api/generated";
import { migrateDown, migrateStatus, migrateUp } from "../api/generated";
import { setWebapiUrl, webapiUrl } from "../api/http";
import { parseFlags, strOpt } from "../lib/args";

function printRun(result: MigrationRunResponse): void {
  for (const line of result.log) console.log(`  ${line}`);
  if (result.applied.length === 0) {
    console.log(
      `migrate: nothing to ${result.direction === "up" ? "apply" : "roll back"} (at v${result.fromVersion})`,
    );
    return;
  }
  const verb = result.dryRun ? "would " : "";
  const applied = result.applied.map((s) => `${s.id} ${s.name}`).join(", ");
  console.log(
    `migrate: ${verb}${result.direction === "up" ? "applied" : "rolled back"} ${result.applied.length} — ${applied}`,
  );
  console.log(
    `migrate: v${result.fromVersion} → v${result.toVersion}${result.dryRun ? " (dry-run)" : ""}`,
  );
}

export async function runMigrate(argv: string[]): Promise<number> {
  const { positionals, options } = parseFlags(argv);
  const direction = positionals[0] ?? "status";
  const dryRun = options["dry-run"] === true;

  const webapiOverride = strOpt(options, "webapi");
  if (webapiOverride) setWebapiUrl(webapiOverride);

  try {
    if (direction === "status") {
      const s = await migrateStatus();
      console.log(
        `migrate: current v${s.currentVersion}, latest v${s.latestVersion} (${webapiUrl()})`,
      );
      if (s.pending.length === 0) {
        console.log("migrate: up to date — no pending migrations");
      } else {
        console.log(`migrate: ${s.pending.length} pending:`);
        for (const p of s.pending) console.log(`  • ${p.id} ${p.name}`);
      }
      return 0;
    }

    if (direction === "up") {
      const toOpt = strOpt(options, "to");
      const result = await migrateUp({ to: toOpt ? Number(toOpt) : undefined, dryRun });
      printRun(result);
      return 0;
    }

    if (direction === "down") {
      const stepsOpt = strOpt(options, "steps");
      const result = await migrateDown({ steps: stepsOpt ? Number(stepsOpt) : 1, dryRun });
      printRun(result);
      return 0;
    }

    console.error(`migrate: unknown direction "${direction}" (use up | down | status)`);
    return 2;
  } catch (err) {
    console.error(`migrate: failed — ${(err as Error).message}`);
    console.error(
      `migrate: is the webapi reachable at ${webapiUrl()}? (set --webapi or $CT_WEBAPI_URL)`,
    );
    return 1;
  }
}

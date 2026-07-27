#!/usr/bin/env bun
import { join } from "node:path";
/**
 * Seed / check the stores named by the app model: create missing CouchDB
 * databases and report the S3 buckets. The plan is **projected from the model**
 * (toSeedPlan) — one source of truth for db/bucket names, shared with the webapi
 * and the manifest. Idempotent.
 *
 *   bun run scripts/seed.ts [--dry-run]
 */
import { buildAppModel, resolveCouchUrlWithAuth, toSeedPlan } from "@claude-transcripts/shared";
import { loadConfigFile } from "./lib/config-file";

const ROOT = join(import.meta.dir, "..");

async function ensureDatabases(dbs: string[]) {
  const base = resolveCouchUrlWithAuth(process.env);
  for (const db of dbs) {
    const head = await fetch(`${base}/${db}`, { method: "HEAD" });
    if (head.ok) {
      console.log(`[seed] couch db exists: ${db}`);
      continue;
    }
    const put = await fetch(`${base}/${db}`, { method: "PUT" });
    console.log(
      put.ok ? `[seed] created couch db: ${db}` : `[seed] FAILED to create ${db}: ${put.status}`,
    );
  }
}

async function main() {
  const dry = process.argv.includes("--dry-run");
  const model = buildAppModel(loadConfigFile(ROOT), process.env);
  const plan = toSeedPlan(model);

  console.log(`[seed] databases: ${plan.databases.join(", ")}`);
  console.log(`[seed] buckets:   ${plan.buckets.join(", ")}`);
  if (dry) {
    console.log("[seed] --dry-run: no changes made");
    return;
  }

  await ensureDatabases(plan.databases);
  // S3 bucket creation needs the Garage admin API/CLI (the bootstrap step).
  for (const b of plan.buckets) {
    console.log(`[seed] bucket (create/verify via the Garage bootstrap): ${b}`);
  }
}

await main();

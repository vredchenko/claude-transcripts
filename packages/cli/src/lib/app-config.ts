/**
 * Load the app config an installed instance runs on.
 *
 * Three places, in order: the instance's own `app.json` (what install seeds and the
 * user may edit), the repo's `config/` when running from a checkout, and finally the
 * template embedded in the binary. The last one is what makes the CLI work with no
 * repo and no install — commands that only need feature flags or store names still
 * behave sensibly on a bare binary.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { AppConfigFile } from "@claude-transcripts/shared";
import { EMBEDDED_ASSETS } from "./assets.generated";
import { installPaths } from "./paths";

/** Repo `config/` when we're running from a checkout, else null. */
function repoConfig(): string | null {
  // packages/cli/src/lib → repo root
  const root = join(import.meta.dir, "..", "..", "..", "..");
  for (const name of ["config.json", "config.template.json"]) {
    const p = join(root, "config", name);
    if (existsSync(p)) return p;
  }
  return null;
}

export function loadAppConfig(): AppConfigFile {
  const paths = installPaths();
  const candidates = [paths.appConfig, repoConfig()].filter((p): p is string => Boolean(p));
  for (const path of candidates) {
    try {
      if (existsSync(path)) return JSON.parse(readFileSync(path, "utf8")) as AppConfigFile;
    } catch {
      // fall through to the next candidate — a corrupt file must not be fatal here
    }
  }
  return JSON.parse(EMBEDDED_ASSETS.appConfig.content) as AppConfigFile;
}

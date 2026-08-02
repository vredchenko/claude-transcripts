/**
 * Materialise the embedded deployment assets into an instance's data dir.
 *
 * The binary carries the compose files and app config template
 * ({@link EMBEDDED_ASSETS}); install writes them out so `docker compose` has real
 * files to read. Rewriting them on every run is deliberate — they belong to the
 * binary's version, so an upgrade replaces them and they can never drift from the code
 * that drives them. Anything a user is meant to customise lives in the instance env or
 * the app config, not here.
 */
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { EMBEDDED_ASSETS } from "./assets.generated";
import type { InstallPaths } from "./paths";

export interface WrittenAsset {
  path: string;
  changed: boolean;
}

/**
 * Write every embedded asset under `dataDir`, reporting which actually changed so a
 * re-run can honestly say "nothing to do".
 *
 * The app config is treated differently: it's the one file a user may edit (feature
 * flags, store names, services menu), so an existing copy is left alone.
 */
export function writeAssets(paths: InstallPaths): WrittenAsset[] {
  const out: WrittenAsset[] = [];
  for (const asset of Object.values(EMBEDDED_ASSETS)) {
    // config/app.json is seeded once, then owned by the user.
    const isUserOwned = asset.path.startsWith("config/");
    const target = isUserOwned ? paths.appConfig : join(paths.dataDir, asset.path);

    if (isUserOwned && existsSync(target)) {
      out.push({ path: target, changed: false });
      continue;
    }
    const previous = existsSync(target) ? readFileSync(target, "utf8") : null;
    if (previous === asset.content) {
      out.push({ path: target, changed: false });
      continue;
    }
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, asset.content);
    out.push({ path: target, changed: true });
  }
  return out;
}

/**
 * Link `<dataDir>/.env` to the instance env.
 *
 * The compose stack reads the environment two different ways: `--env-file` supplies
 * variable *substitution* for the compose file itself, but the app service also has
 * `env_file: ../.env`, which is what populates the container's own environment —
 * resolved relative to the compose file, so `<dataDir>/.env`. A symlink satisfies both
 * from the one real file, instead of copying secrets to a second location that could
 * then drift.
 */
export function linkInstanceEnv(paths: InstallPaths): void {
  const link = join(paths.dataDir, ".env");
  try {
    if (lstatSync(link, { throwIfNoEntry: false })) unlinkSync(link);
  } catch {
    // not there, or not removable — symlinkSync below will report if it matters
  }
  mkdirSync(paths.dataDir, { recursive: true });
  symlinkSync(paths.instanceEnv, link);
}

/** Record which version the written-out assets belong to. */
export function writeVersionStamp(paths: InstallPaths, version: string): void {
  mkdirSync(dirname(paths.versionFile), { recursive: true });
  writeFileSync(paths.versionFile, `${version}\n`);
}

/** Version the installed assets were written for, or null if never installed. */
export function readVersionStamp(paths: InstallPaths): string | null {
  try {
    return readFileSync(paths.versionFile, "utf8").trim() || null;
  } catch {
    return null;
  }
}

/** Absolute paths to the compose files, in `-f` order (later overrides win). */
export function composeFiles(paths: InstallPaths, upstream: boolean): string[] {
  const files = [join(paths.dataDir, EMBEDDED_ASSETS.compose.path)];
  if (upstream) files.push(join(paths.dataDir, EMBEDDED_ASSETS.composeUpstream.path));
  return files;
}

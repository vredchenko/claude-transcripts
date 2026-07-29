#!/usr/bin/env bun
/**
 * Release: stamp one lockstep semver across every component manifest (ADR 0023),
 * so a `vX.Y.Z` tag and the versions in the tree always agree. Dev-only tooling —
 * the actual building and publishing runs in GitHub Actions on the tag
 * (publish-image, mirror-images, release-cli; see docs/operate/releasing.md).
 *
 *   bun run scripts/release.ts 0.1.0     # bump, then commit + tag by hand
 *   bun run scripts/release.ts 0.1.0 --check   # verify only, no writes
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Every manifest carrying the lockstep version. Keep in sync with ADR 0023. */
const MANIFESTS = [
  "package.json",
  "packages/shared/package.json",
  "packages/webapi/package.json",
  "packages/webui/package.json",
  "packages/cli/package.json",
  "hooks/.claude-plugin/plugin.json",
];

const ROOT = join(import.meta.dir, "..");
const version = process.argv[2];
const check = process.argv.includes("--check");

if (!version || !/^\d+\.\d+\.\d+$/.test(version)) {
  throw new Error("usage: release.ts <semver> [--check]  (e.g. 0.1.0)");
}

// Rewrite the version in place rather than re-serialising the JSON: these files are
// format-checked by biome, and a full round-trip would reflow unrelated lines.
const VERSION_LINE = /^(\s*"version"\s*:\s*")([^"]*)(")/m;

let stale = 0;
for (const rel of MANIFESTS) {
  const path = join(ROOT, rel);
  const raw = readFileSync(path, "utf8");
  const found = raw.match(VERSION_LINE);
  if (!found) {
    throw new Error(`${rel}: no "version" field to stamp — add one first`);
  }
  if (found[2] === version) {
    console.log(`[release] ${rel} already ${version}`);
    continue;
  }
  stale++;
  if (check) {
    console.log(`[release] ${rel} is ${found[2]}, expected ${version}`);
    continue;
  }
  writeFileSync(path, raw.replace(VERSION_LINE, `$1${version}$3`));
  console.log(`[release] ${rel}: ${found[2]} → ${version}`);
}

if (check) {
  if (stale > 0) {
    throw new Error(`${stale} manifest(s) not at ${version} — run without --check to stamp`);
  }
  console.log(`[release] all manifests at ${version}`);
} else {
  console.log(`[release] stamped ${version}; next: commit, then tag v${version} and push`);
}

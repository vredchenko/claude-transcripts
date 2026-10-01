#!/usr/bin/env bun
/**
 * Release: stamp one lockstep semver across every component manifest (ADR 0023),
 * so a `vX.Y.Z` tag and the versions in the tree always agree. Dev-only tooling —
 * the actual building and publishing runs in GitHub Actions on the tag
 * (publish-image, mirror-images, release-cli; see docs/operate/releasing.md).
 *
 *   bun run scripts/release.ts 0.1.0     # bump, then commit + tag by hand
 *   bun run scripts/release.ts 0.1.0 --check   # verify only, no writes
 *
 * Stamping also re-runs gen:k8s (the k8s base pins the app image); --check verifies it.
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildAppModel, k8sImageRef, k8sWorkloadServices } from "@claude-transcripts/shared";
import { loadConfigTemplate } from "./lib/config-file";

/** Every manifest carrying the lockstep version. Keep in sync with ADR 0023. */
const MANIFESTS = [
  "package.json",
  "packages/shared/package.json",
  "packages/webapi/package.json",
  "packages/webui/package.json",
  "packages/cli/package.json",
  "hooks/.claude-plugin/plugin.json",
  ".claude-plugin/marketplace.json",
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

const K8S_BASE = join(ROOT, "deploy", "k8s", "base");
if (!check) {
  const gen = Bun.spawnSync(["bun", "run", "scripts/gen-k8s.ts"], {
    cwd: ROOT,
    stdout: "inherit",
    stderr: "inherit",
  });
  if (gen.exitCode !== 0) throw new Error("gen-k8s failed — the k8s base was not re-pinned");
}
const base = readdirSync(K8S_BASE)
  .filter((f) => f.endsWith(".yaml"))
  .map((f) => readFileSync(join(K8S_BASE, f), "utf8"))
  .join("\n");
const ownImages = k8sWorkloadServices(buildAppModel(loadConfigTemplate(ROOT), {}))
  .filter((s) => !s.image?.upstream)
  .map((s) => k8sImageRef(s, version));
const unpinned = ownImages.filter((ref) => !base.includes(`image: ${ref}\n`));
for (const ref of unpinned) console.log(`[release] deploy/k8s/base does not run ${ref}`);

if (check) {
  if (stale > 0 || unpinned.length > 0) {
    throw new Error(
      `${stale} manifest(s) not at ${version}, ${unpinned.length} k8s image(s) not pinned to it` +
        " — run without --check to stamp",
    );
  }
  console.log(`[release] all manifests and the k8s base at ${version}`);
} else {
  if (unpinned.length > 0) throw new Error("k8s base still not pinned after gen-k8s");
  console.log(`[release] stamped ${version}; next: commit, then tag v${version} and push`);
}

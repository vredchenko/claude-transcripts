/**
 * The version has exactly one source: the committed manifests (#289). These guard
 * against a second one creeping back — a build argument, an env override, a dev
 * marker — which is how the omnibus came to report 0.0.0-dev while shipping 0.10.2.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { APP_SEMVER, APP_VERSION } from "./version";

const ROOT = join(import.meta.dir, "..", "..", "..");

/** The lockstep manifests scripts/release.ts stamps (ADR 0023). */
const MANIFESTS = [
  "package.json",
  "packages/shared/package.json",
  "packages/webapi/package.json",
  "packages/webui/package.json",
  "packages/cli/package.json",
  "hooks/.claude-plugin/plugin.json",
];

function walk(dir: string, keep: (path: string) => boolean, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name === ".git" || e.name === "dist") continue;
    const path = join(dir, e.name);
    if (e.isDirectory()) walk(path, keep, out);
    else if (keep(path)) out.push(path);
  }
  return out;
}

describe("APP_VERSION", () => {
  test("is the shared package.json version, spelled as the tag", () => {
    expect(APP_VERSION).toBe(`v${APP_SEMVER}`);
    expect(APP_SEMVER).toMatch(/^\d+\.\d+\.\d+$/);
  });

  test("every lockstep manifest carries it — webapi, webui, CLI and plugin alike", () => {
    for (const rel of MANIFESTS) {
      const { version } = JSON.parse(readFileSync(join(ROOT, rel), "utf8")) as {
        version: string;
      };
      expect(`${rel}@${version}`).toBe(`${rel}@${APP_SEMVER}`);
    }
    const market = JSON.parse(readFileSync(join(ROOT, ".claude-plugin/marketplace.json"), "utf8"));
    for (const p of market.plugins as { version: string }[]) expect(p.version).toBe(APP_SEMVER);
  });
});

describe("no second version source", () => {
  test("CT_VERSION appears nowhere in builds, workflows or source", () => {
    const files = [
      ...walk(join(ROOT, "packages"), (p) => /[\\/]src[\\/].*\.tsx?$/.test(p)),
      ...walk(join(ROOT, ".github"), (p) => /\.ya?ml$/.test(p)),
      ...walk(join(ROOT, "deploy"), (p) => /(Dockerfile|\.hcl|\.ya?ml)$/.test(p)),
      ...walk(join(ROOT, "scripts"), (p) => p.endsWith(".ts")),
      join(ROOT, "Dockerfile"),
    ].filter((p) => !p.endsWith("version.test.ts"));
    const offenders = files
      .filter((p) => readFileSync(p, "utf8").includes("CT_VERSION"))
      .map((p) => relative(ROOT, p));
    expect(offenders).toEqual([]);
  });

  test("no dev-version fallback is reintroduced", () => {
    const files = walk(join(ROOT, "packages"), (p) => /[\\/]src[\\/].*\.tsx?$/.test(p)).filter(
      (p) => !p.endsWith("version.test.ts") && !p.endsWith("generated.ts"),
    );
    const offenders = files
      .filter((p) => readFileSync(p, "utf8").includes("0.0.0-dev"))
      .map((p) => relative(ROOT, p));
    expect(offenders).toEqual([]);
  });
});

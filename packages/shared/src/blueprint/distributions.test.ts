/**
 * The distribution table (docs/reference/distributions.md) is only worth having if it
 * can't fall behind what the repo actually ships. These hold it to SERVICES and to the
 * files it names.
 */
import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  COMPONENTS,
  DISTRIBUTIONS,
  NON_SERVICE_COMPONENTS,
  toDistributionsDoc,
} from "./distributions";
import { SERVICES } from "./services";

const ROOT = join(import.meta.dir, "..", "..", "..", "..");

describe("distributions", () => {
  test("keys are unique", () => {
    const keys = DISTRIBUTIONS.map((d) => d.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  test("every published image belongs to a distribution", () => {
    const published = new Set(DISTRIBUTIONS.flatMap((d) => d.images ?? []));
    for (const s of SERVICES) {
      if (s.image) expect(published).toContain(s.image.name);
    }
  });

  test("every component that isn't docs or the plugin is a service", () => {
    const services = new Set(SERVICES.map((s) => s.key));
    for (const c of COMPONENTS) {
      if (!NON_SERVICE_COMPONENTS.includes(c.key)) expect(services).toContain(c.key);
    }
  });

  test("every backing and admin-UI service is a column", () => {
    const columns = new Set<string>(COMPONENTS.map((c) => c.key));
    for (const s of SERVICES) {
      if (s.role === "backing" || s.role === "admin-ui") expect(columns).toContain(s.key);
    }
  });

  for (const d of DISTRIBUTIONS) {
    test(`${d.key}: carries something, and every file it names exists`, () => {
      expect(d.contains.length).toBeGreaterThan(0);
      for (const f of d.builtBy) expect(existsSync(join(ROOT, f))).toBe(true);
    });
  }

  test("the deploy definitions run every backing service", () => {
    const backing = SERVICES.filter((s) => s.role === "backing").map((s) => s.key);
    for (const key of ["compose", "kustomize"]) {
      const runs: string[] = DISTRIBUTIONS.find((x) => x.key === key)?.contains ?? [];
      for (const b of backing) expect(runs).toContain(b);
    }
  });

  test("placeholders survive Markdown", () => {
    const doc = toDistributionsDoc();
    expect(doc).toContain("ghcr.io/&lt;owner&gt;/claude-transcripts-app");
    expect(doc).not.toContain("<owner>");
  });
});

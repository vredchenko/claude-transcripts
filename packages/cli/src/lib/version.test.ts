import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runningFromSource, VERSION } from "./version";

const pkgVersion = (rel: string) =>
  (JSON.parse(readFileSync(join(import.meta.dir, rel), "utf8")) as { version: string }).version;

describe("VERSION (#289)", () => {
  test("is the CLI's package.json version, spelled as the tag", () => {
    expect(VERSION).toBe(`v${pkgVersion("../../package.json")}`);
  });

  test("agrees with the shared package it is read from (lockstep, ADR 0023)", () => {
    expect(VERSION).toBe(`v${pkgVersion("../../../shared/package.json")}`);
  });

  test("is never a dev marker", () => {
    expect(VERSION).toMatch(/^v\d+\.\d+\.\d+$/);
  });
});

describe("runningFromSource", () => {
  test("a checkout's CLI source is 'from source'", () => {
    expect(runningFromSource("/home/u/dev/ct/packages/cli/src/lib/version.ts")).toBe(true);
    expect(runningFromSource(import.meta.path)).toBe(true);
  });

  test("a compiled binary or the npm bundle is not", () => {
    expect(runningFromSource("/$bunfs/root/claude-transcripts")).toBe(false);
    expect(runningFromSource("/usr/lib/node_modules/@claude-transcripts/cli/dist/cli.js")).toBe(
      false,
    );
  });
});

import { describe, expect, test } from "bun:test";
import { CLI_TARGETS } from "./cli-targets";

describe("CLI_TARGETS", () => {
  test("assets are unique", () => {
    const assets = CLI_TARGETS.map((t) => t.asset);
    expect(new Set(assets).size).toBe(assets.length);
  });

  test("each asset is named for its Bun target, os, arch, libc and CPU level", () => {
    for (const t of CLI_TARGETS) {
      const want = `${t.os}-${t.arch}${t.musl ? "-musl" : ""}${t.baseline ? "-baseline" : ""}`;
      expect(t.asset).toBe(want);
      expect(t.bunTarget).toBe(`bun-${t.asset}`);
    }
  });

  test("only x64 has baseline builds, and only Linux has musl ones", () => {
    for (const t of CLI_TARGETS) {
      if (t.baseline) expect(t.arch).toBe("x64");
      if (t.musl) expect(t.os).toBe("linux");
    }
  });

  test("a QEMU smoke run is x86-64 only (the smoke script uses qemu-x86_64)", () => {
    for (const t of CLI_TARGETS) if (t.smoke?.qemuCpu) expect(t.arch).toBe("x64");
  });
});

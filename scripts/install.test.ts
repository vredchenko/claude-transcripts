/**
 * install.sh's platform detection, run for real under `sh` against a fake system:
 * `uname` and `ldd` are stubs on PATH, and `_CT_SYSROOT` points the files it reads
 * (/proc/cpuinfo, /etc/alpine-release, the libstdc++ check) into a temp dir. Every
 * Linux release target must be what some machine detects as (ADR 0036).
 */
import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLI_TARGETS } from "@claude-transcripts/shared";

const INSTALL_SH = join(import.meta.dir, "..", "install.sh");
const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

interface Machine {
  os?: string;
  arch: string;
  alpine?: boolean;
  /** What `ldd --version` prints (glibc's says "GNU libc"). */
  ldd?: string;
  avx2?: boolean;
  /** No /proc/cpuinfo at all. */
  noCpuinfo?: boolean;
  libstdcxx?: boolean;
}

function fakeSystem(m: Machine): { root: string; bin: string } {
  const root = mkdtempSync(join(tmpdir(), "ct-install-"));
  dirs.push(root);
  const bin = join(root, "stub-bin");
  mkdirSync(bin);
  const stub = (name: string, body: string) => {
    writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`);
    chmodSync(join(bin, name), 0o755);
  };
  stub("uname", `case "$1" in -s) echo ${m.os ?? "Linux"} ;; -m) echo ${m.arch} ;; esac`);
  stub("ldd", `echo "${m.ldd ?? "ldd (GNU libc) 2.39"}"`);
  if (!m.noCpuinfo) {
    mkdirSync(join(root, "proc"));
    writeFileSync(
      join(root, "proc", "cpuinfo"),
      `flags\t\t: fpu sse sse2 ssse3 sse4_1 sse4_2${m.avx2 ? " avx avx2" : ""} popcnt\n`,
    );
  }
  if (m.alpine) {
    mkdirSync(join(root, "etc"));
    writeFileSync(join(root, "etc", "alpine-release"), "3.22.0\n");
  }
  if (m.libstdcxx) {
    mkdirSync(join(root, "usr", "lib"), { recursive: true });
    writeFileSync(join(root, "usr", "lib", "libstdc++.so.6"), "");
    writeFileSync(join(root, "usr", "lib", "libgcc_s.so.1"), "");
  }
  return { root, bin };
}

/** Source install.sh (without running it) and evaluate `script` in it. */
function inInstaller(m: Machine, script: string) {
  const { root, bin } = fakeSystem(m);
  const r = Bun.spawnSync(["sh", "-c", `. "${INSTALL_SH}"; ${script}`], {
    env: {
      PATH: `${bin}:/usr/bin:/bin`,
      HOME: root,
      _CT_SOURCE_ONLY: "1",
      _CT_SYSROOT: root,
    },
  });
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
}

const detect = (m: Machine) => inInstaller(m, "detect_target").out;

describe("install.sh detect_target", () => {
  const cases: [string, Machine, string][] = [
    ["glibc x64 with AVX2", { arch: "x86_64", avx2: true }, "linux-x64"],
    ["glibc x64 without AVX2", { arch: "x86_64" }, "linux-x64-baseline"],
    ["Alpine x64 with AVX2", { arch: "x86_64", alpine: true, avx2: true }, "linux-x64-musl"],
    ["Alpine x64 without AVX2", { arch: "x86_64", alpine: true }, "linux-x64-musl-baseline"],
    [
      "musl without alpine-release, told by ldd",
      { arch: "x86_64", ldd: "musl libc (x86_64)", avx2: true },
      "linux-x64-musl",
    ],
    [
      "x64 with no readable cpuinfo plays safe",
      { arch: "amd64", noCpuinfo: true },
      "linux-x64-baseline",
    ],
    ["glibc arm64", { arch: "aarch64" }, "linux-arm64"],
    ["Alpine arm64", { arch: "aarch64", alpine: true }, "linux-arm64-musl"],
    ["macOS Apple Silicon", { os: "Darwin", arch: "arm64" }, "darwin-arm64"],
    ["macOS Intel ignores cpuinfo", { os: "Darwin", arch: "x86_64" }, "darwin-x64"],
  ];
  for (const [name, machine, want] of cases) {
    test(name, () => expect(detect(machine)).toBe(want));
  }

  test("every release target is what some machine detects as", () => {
    const detected = new Set(cases.map(([, , want]) => want));
    for (const t of CLI_TARGETS) expect(detected).toContain(t.asset);
  });

  test("an unsupported architecture is refused, naming what exists", () => {
    const r = inInstaller({ arch: "riscv64" }, "detect_target");
    expect(r.code).not.toBe(0);
    expect(r.err).toContain("unsupported architecture: riscv64");
    expect(r.err).toContain("linux-x64-musl");
  });
});

describe("install.sh SUPPORTED_TARGETS", () => {
  test("is the blueprint's list", () => {
    const r = inInstaller({ arch: "x86_64" }, 'printf %s "$SUPPORTED_TARGETS"');
    expect(r.out.split(" ")).toEqual(CLI_TARGETS.map((t) => t.asset));
  });
});

describe("install.sh check_musl_runtime", () => {
  test("refuses a musl build without libstdc++, with the apk command", () => {
    const r = inInstaller({ arch: "x86_64", alpine: true }, "check_musl_runtime linux-x64-musl");
    expect(r.code).not.toBe(0);
    expect(r.err).toContain("apk add libstdc++ libgcc");
  });

  test("passes when the C++ runtime is there", () => {
    const r = inInstaller(
      { arch: "x86_64", alpine: true, libstdcxx: true },
      "check_musl_runtime linux-x64-musl && echo ok",
    );
    expect(r.out.trim()).toBe("ok");
  });

  test("doesn't apply to glibc builds", () => {
    expect(
      inInstaller({ arch: "x86_64" }, "check_musl_runtime linux-x64 && echo ok").out.trim(),
    ).toBe("ok");
  });
});

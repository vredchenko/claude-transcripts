/**
 * Every platform the CLI is released for: the one list behind the release build, the
 * installer, the omnibus downloads and the docs (ADR 0036).
 *
 * It used to be typed out in five places (release-cli.yml, the omnibus Dockerfile, its
 * downloads page, its smoke test and the install docs), and `install.sh` mapped
 * `uname` to names it could only hope were published. Adding a target here and running
 * `bun run gen:all` now updates every one of them; `cli-targets.test.ts` holds the
 * generated regions to this list.
 */

export type CliOs = "linux" | "darwin";
export type CliArch = "x64" | "arm64";

export interface CliTargetDef {
  /** The asset's suffix: `claude-transcripts-<asset>` (+ `.sha256`) on each release. */
  asset: string;
  /** `bun build --compile --target=` value. */
  bunTarget: string;
  os: CliOs;
  arch: CliArch;
  /** musl libc (Alpine and other musl distributions) rather than glibc. */
  musl?: boolean;
  /** For x86-64 CPUs without AVX2. The default x64 builds need it. */
  baseline?: boolean;
  /** Human label, for tables and the downloads page. */
  label: string;
  /** Also served by the omnibus image at /downloads/ (each binary is about 100 MB). */
  omnibus?: boolean;
  /**
   * How release-cli.yml runs this binary on its own platform before publishing.
   * `runner` is the GitHub-hosted runner; `image` runs the check in that container;
   * `qemuCpu` runs the binary under qemu-user with that CPU model. `detected` means
   * `install.sh` should pick this asset by itself there, and the smoke test checks it
   * did. Omitted: built and published, not run (no runner in scope).
   */
  smoke?: { runner: string; image?: string; qemuCpu?: string; detected: boolean };
}

export const CLI_TARGETS: CliTargetDef[] = [
  {
    asset: "linux-x64",
    bunTarget: "bun-linux-x64",
    os: "linux",
    arch: "x64",
    label: "Linux x64 (glibc)",
    omnibus: true,
    smoke: { runner: "ubuntu-latest", detected: true },
  },
  {
    asset: "linux-x64-baseline",
    bunTarget: "bun-linux-x64-baseline",
    os: "linux",
    arch: "x64",
    baseline: true,
    label: "Linux x64 (glibc), CPUs without AVX2",
    smoke: { runner: "ubuntu-latest", image: "ubuntu:24.04", qemuCpu: "Nehalem", detected: false },
  },
  {
    asset: "linux-x64-musl",
    bunTarget: "bun-linux-x64-musl",
    os: "linux",
    arch: "x64",
    musl: true,
    label: "Linux x64 (musl, e.g. Alpine)",
    smoke: { runner: "ubuntu-latest", image: "alpine:3", detected: true },
  },
  {
    asset: "linux-x64-musl-baseline",
    bunTarget: "bun-linux-x64-musl-baseline",
    os: "linux",
    arch: "x64",
    musl: true,
    baseline: true,
    label: "Linux x64 (musl), CPUs without AVX2",
    smoke: { runner: "ubuntu-latest", image: "alpine:3", qemuCpu: "Nehalem", detected: false },
  },
  {
    asset: "linux-arm64",
    bunTarget: "bun-linux-arm64",
    os: "linux",
    arch: "arm64",
    label: "Linux arm64 (glibc)",
    omnibus: true,
    smoke: { runner: "ubuntu-24.04-arm", detected: true },
  },
  {
    asset: "linux-arm64-musl",
    bunTarget: "bun-linux-arm64-musl",
    os: "linux",
    arch: "arm64",
    musl: true,
    label: "Linux arm64 (musl, e.g. Alpine)",
    smoke: { runner: "ubuntu-24.04-arm", image: "alpine:3", detected: true },
  },
  {
    asset: "darwin-x64",
    bunTarget: "bun-darwin-x64",
    os: "darwin",
    arch: "x64",
    label: "macOS Intel",
    omnibus: true,
  },
  {
    asset: "darwin-arm64",
    bunTarget: "bun-darwin-arm64",
    os: "darwin",
    arch: "arm64",
    label: "macOS Apple Silicon",
    omnibus: true,
  },
];

export const cliAssetName = (t: CliTargetDef) => `claude-transcripts-${t.asset}`;

/** The space-separated `bun build` targets, for a shell `for` loop. */
export function toCliBuildTargets(targets = CLI_TARGETS): string {
  return targets.map((t) => t.bunTarget).join(" ");
}

/** install.sh's list of assets it may pick, as a shell assignment. */
export function toInstallShTargets(targets = CLI_TARGETS): string {
  return `SUPPORTED_TARGETS="${targets.map((t) => t.asset).join(" ")}"`;
}

/** The omnibus image's subset, as asset suffixes for its Dockerfile loop. */
export function toOmnibusTargets(targets = CLI_TARGETS): string {
  return targets
    .filter((t) => t.omnibus)
    .map((t) => t.asset)
    .join(" ");
}

/** release-cli.yml's smoke matrix `include:` entries, indented for that file. */
export function toCliSmokeMatrix(targets = CLI_TARGETS, indent = "          "): string {
  return targets
    .filter((t) => t.smoke)
    .map((t) => {
      const s = t.smoke!;
      const lines = [`- asset: ${t.asset}`, `  runner: ${s.runner}`];
      lines.push(`  image: "${s.image ?? ""}"`);
      lines.push(`  qemu_cpu: "${s.qemuCpu ?? ""}"`);
      lines.push(`  detected: ${s.detected}`);
      return lines.map((l) => indent + l).join("\n");
    })
    .join("\n");
}

/** The omnibus downloads page's table rows. */
export function toDownloadsRows(targets = CLI_TARGETS): string {
  return targets
    .filter((t) => t.omnibus)
    .map((t) => {
      const name = cliAssetName(t);
      return `  <tr><td>${t.label}</td><td><a href="${name}">${name}</a></td></tr>`;
    })
    .join("\n");
}

/** The install docs' table of release assets. */
export function toCliTargetsDoc(targets = CLI_TARGETS): string {
  const rows = targets.map((t) => {
    const how = !t.smoke
      ? "built, not run in CI"
      : t.smoke.qemuCpu
        ? `run under QEMU (\`-cpu ${t.smoke.qemuCpu}\`)${t.smoke.image ? ` in \`${t.smoke.image}\`` : ""}`
        : `run on \`${t.smoke.runner}\`${t.smoke.image ? ` in \`${t.smoke.image}\`` : ""}`;
    return `| ${t.label} | \`${cliAssetName(t)}\` | ${how} |`;
  });
  return [
    "| Platform | Release asset | Checked before release |",
    "| --- | --- | --- |",
    ...rows,
  ].join("\n");
}

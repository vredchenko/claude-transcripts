# 36. CLI release targets: one list, every Linux binary run on its platform

Date: 2026-11-27

## Status

Accepted. From issue #305, Linux part; Windows and macOS checks are out of scope for now.

## Context

The CLI ships as self-contained binaries built with `bun build --compile`, for Linux
and macOS on x64 and arm64. Two groups of Linux users couldn't run them:

- **musl systems** (Alpine, and containers built on it): the glibc binary doesn't load.
- **x86-64 CPUs without AVX2** (pre-2013 CPUs, some VMs and emulators): Bun's default
  x64 build dies with `Illegal instruction`, which is a crash, not a refusal.

Bun can build for both (`-musl`, `-baseline`, and `-musl-baseline` for both at once).
The list of targets was typed out in five places: `release-cli.yml`, the omnibus
`Dockerfile`, its downloads page, its smoke test and the install docs. `install.sh`
mapped `uname` to asset names it could only hope a release had. And only the
`linux-x64` binary was ever executed before a release published it.

## Decision

- **Four more Linux targets:** `linux-x64-musl`, `linux-arm64-musl`,
  `linux-x64-baseline` and `linux-x64-musl-baseline`, alongside the existing four.
- **One list.** `CLI_TARGETS` in `packages/shared/src/blueprint/cli-targets.ts` is the
  only place targets are listed. `bun run gen:distributions` (part of `gen:all`) writes
  it into the release workflow's build loop and smoke matrix, `install.sh`'s
  `SUPPORTED_TARGETS`, the omnibus build and downloads page, the install docs and the
  distribution table. `smoke-omnibus.ts` imports it. CI fails if a generated region is
  stale.
- **`install.sh` detects the build.** musl from `/etc/alpine-release` or `ldd --version`;
  AVX2 from `/proc/cpuinfo`, where an unreadable file counts as "no AVX2", since the
  baseline build runs everywhere. `CT_INSTALL_TARGET` overrides detection. Before
  downloading a musl build it checks for `libstdc++` and `libgcc`, which those builds
  link dynamically and a minimal Alpine lacks, and names the `apk add`. Before putting a
  binary on `PATH` it runs `--version`, and on failure suggests the baseline build.
  `CT_DOWNLOAD_URL` installs from somewhere other than the GitHub release (an omnibus
  instance's `/downloads`, or the build's own artefacts in CI).
- **Every Linux binary is run on its own platform before it is published.**
  `release-cli.yml` builds, then smoke-tests each target, then publishes only if all
  pass. Each check (`scripts/smoke-cli-binary.sh`) installs the binary through
  `install.sh` from the build's files, and checks that install.sh picked it unprompted
  wherever the runner can show that. It then runs `--version`, `--help` and an offline
  `hook run`. The checks run on the x64 and arm64 Ubuntu runners, in `alpine:3` for musl,
  and under `qemu-x86_64 -cpu Nehalem` for baseline. The workflow also runs on PRs that
  touch any of this.
- **The omnibus image keeps serving four binaries** (glibc x64/arm64, macOS x64/arm64),
  marked `omnibus: true` in the list. Each binary is about 100 MB; the others are on the
  release, and its downloads page says so.

## Consequences

- A release carries eight binaries, about 800 MB uncompressed; GitHub's limit is 2 GB
  per asset, and there is no total limit for a release.
- QEMU's user-mode emulation executes AVX2 instructions whatever CPU model it is told
  to emulate, so the baseline check proves the binary starts on that model, not that it
  avoids AVX2. That guarantee is Bun's.
- The macOS binaries are built and published but not run in CI, as before. Windows
  remains WSL2-only. Both, with signing and compressed assets, are left for later
  (#305).
- Asset names are unchanged for existing targets, so installers and tools that fetch
  by name (mise, ubi, eget) keep working.

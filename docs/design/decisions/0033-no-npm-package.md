# 33. No npm package

Date: 2026-11-26

## Status

Accepted. Amends [ADR 0012](0012-github-actions-and-ghcr-for-releases.md): `release-cli.yml`
no longer publishes to npm.

## Context

Each release published the CLI in two forms: self-contained binaries on the GitHub
Release, and `@claude-transcripts/cli` on npm, a bundle that needs Bun to run.

The npm package's only job was a one-line start: `bunx @claude-transcripts/cli
install`. `install.sh` does the same in one line (`curl -fsSL …/install.sh | sh`) and
needs nothing installed: it fetches the right binary, checks its sha256 and runs
`install`. Anyone with Bun on their machine can run that too, so the npm package
offered nobody anything the binaries didn't. Under `npx` it was worse, since it only
works when Bun is installed as well.

It also had costs:

- It was the one release artifact that needed a secret. npm caps write tokens at 90
  days, so `NPM_TOKEN` expires every quarter. When it expired, v0.13.0's
  `release-cli` failed after the binaries were already up.
- A second build (`scripts/build-cli-npm.ts`) and a manifest to keep publishable
  (`bin`, `files`, `publishConfig`, the staged licence), none of which the binaries
  use.
- An npm org and token to set up before anyone else can cut a release from a fork.

## Decision

Stop publishing to npm. The CLI is distributed as the release binaries, installed by
`install.sh` or downloaded by hand, and inside the app and omnibus images.

- `release-cli.yml` builds and attaches the binaries, and nothing else. It needs no
  secrets.
- `scripts/build-cli-npm.ts` is deleted. `packages/cli/package.json` is `private`, so
  it can't be published by accident.
- The blueprint's distributions (`DISTRIBUTIONS`) drop the `npm` entry and the `npm`
  kind. The generated [distributions reference](../../reference/distributions.md)
  follows.

Versions already on npm (up to 0.12.1) stay there; npm doesn't allow deleting them.
They can be deprecated so `npm` warns anyone who installs one and points them to
`install.sh`.

## Consequences

- One way to get the CLI on a machine, and it works without Bun.
- A release needs no secrets beyond the built-in `GITHUB_TOKEN`.
- `bunx @claude-transcripts/cli` stops getting new versions. Docs and the admin skill
  point to `install.sh` instead.
- The CLI's package name stays `@claude-transcripts/cli`. It's the workspace name the
  monorepo's filters and imports use, and it no longer names anything that's published.

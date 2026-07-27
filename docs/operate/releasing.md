# Releasing & publishing

Everything is **lockstep-versioned** (ADR 0023): one `vMAJOR.MINOR.PATCH` git tag
drives every published artifact. Push the tag and CI does the rest.

## What a `vX.Y.Z` tag publishes

| Artifact | Where | Workflow |
|----------|-------|----------|
| **App image** (`claude-transcripts-app` — webapi + webui SPA + docs + bundled CLI) | GHCR: `ghcr.io/<owner>/claude-transcripts-app` | [`publish-image.yml`](../../.github/workflows/publish-image.yml) |
| **Mirrored backing images** (CouchDB, Garage, Meilisearch + admin UIs) | GHCR: `ghcr.io/<owner>/claude-transcripts-*` | [`mirror-images.yml`](../../.github/workflows/mirror-images.yml) (also on-demand) |
| **CLI binaries** (Linux + macOS, x64 + arm64) + SHA-256 sums | GitHub Release assets | [`release-cli.yml`](../../.github/workflows/release-cli.yml) |
| **CLI on npm** (`@claude-transcripts/cli`, a bun-runnable bundle) | npmjs.org | `release-cli.yml` |

The CLI needs **bun** at runtime (it uses Bun APIs). So: the **compiled binaries** are
the zero-dependency option (`curl` the one for your platform from the Release); the
**npm** package is for bun users (`bunx @claude-transcripts/cli`, or a global install
with bun on `PATH`).

## Cutting a release

```bash
# bump versions (lockstep) and tag — scripts/release.ts automates the bump
git tag v0.1.0
git push origin v0.1.0
```

CI then builds + publishes all of the above. A **manual** `release-cli` /
`mirror-images` dispatch (Actions tab → Run workflow) is available for testing —
`release-cli` on dispatch uploads the binaries as workflow artifacts without
publishing.

## One-time setup ("click-admin")

CI uses the built-in `GITHUB_TOKEN` to push to GHCR — **no secret needed** for the
images. The manual bits, once:

1. **Make the GHCR packages public** (so anyone can `docker pull` without auth):
   after the first publish, each package appears under your profile/org → open it →
   **Package settings → Change visibility → Public**. Do this for
   `claude-transcripts-app` and each mirrored `claude-transcripts-*`. (Repo →
   Settings → Actions → General → Workflow permissions should allow read/write.)
2. **npm:**
   - Own the scope: create the **`claude-transcripts` org** on npmjs (the package is
     `@claude-transcripts/cli`, published with `--access public`).
   - Create an npm **Automation** access token (npmjs → Access Tokens) and add it as
     the repo secret **`NPM_TOKEN`** (Settings → Secrets and variables → Actions).
3. *(Optional)* a protected **`release` environment** (Settings → Environments) if you
   want a manual approval gate before publishing.

## After releasing: pull from your own registry

Point the stack at your mirrored images instead of external registries (so an
unmaintained/unverified upstream can never ship you a surprise):

```bash
# in .env
IMAGE_NS=ghcr.io/<owner>
```

Then `bun run stack:up` (without `--upstream`) pulls `couchdb`, `garage`,
`meilisearch`, the admin UIs, **and** the app image from `ghcr.io/<owner>/…` only.
Re-run `mirror-images` (or tag a release) whenever you bump a pinned upstream tag in
`scripts/mirror-images.ts` + `.env.template`.

## Notes

- **Backing image tags are pinned** in `scripts/mirror-images.ts`, `.env.template`,
  and the app model (`packages/shared/src/model/services.ts`) — keep them in lockstep.
- The npm bundle inlines all dependencies (`bun build --target=bun`), so the published
  package declares **no runtime deps** (the workflow drops the `workspace:` protocol
  before publishing). The binaries embed the bun runtime, so they need nothing.

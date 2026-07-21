# Branching & workflow

> Effective now. The old "commit straight to `main`" guidance is retired in
> favour of the feature-branch → PR flow below.

> **Note: the repo has no git remote yet** (the owner handles repo creation
> later, so this is currently a **local-only** repository). The branch model below
> applies once the repo gets its remote on GitHub; until then `main` and any
> `feat/*` branches exist as local branches and the "push / open a PR" steps take
> effect after the remote is added.

## Branches

| Branch | Role |
|--------|------|
| **`main`** | **The single primary branch.** All development integrates here; releases are cut from it. |
| `feat/<topic>` | Short-lived feature branches, **branched off `main`**, merged back via PR **into `main`**. |

## Workflow

1. Branch a feature off `main`: `git checkout -b feat/<topic> main`.
2. Commit with `git commit --no-verify` (skips the lefthook biome pre-commit so
   nothing runs locally — per the [operating constraints](../CLAUDE.md)).
3. Push and open a PR **into `main`** (once the GitHub remote exists).
4. Merge to `main`. Releases are cut from `main` (see
   [development.md](development.md) → releases; semver, all parts versioned
   together).

CI on `main` runs lint/typecheck/build on every push and PR
([development.md](development.md)); a `vX.Y.Z` tag drives the release image build.

## Why

A fresh public GitHub repo starts with a clean history, so a single `main` is the
integration line for all work. The `feat/<topic>` → PR flow keeps each change
reviewable and lets CI gate merges, without a separate long-lived integration
branch.

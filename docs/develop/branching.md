# Branching & workflow

> Effective now. The old "commit straight to `main`" guidance is retired in
> favour of the feature-branch → PR flow below.

The repo lives on GitHub at
[`vredchenko/claude-transcripts`](https://github.com/vredchenko/claude-transcripts),
so the whole flow below — push, PR, CI gate, merge — is live. **Rebase is the only
merge strategy enabled** on the repo, which keeps `main` linear; put the PR/issue
reference in the branch commit message, since rebase appends no `(#N)` suffix.

## Branches

| Branch | Role |
|--------|------|
| **`main`** | **The single primary branch.** All development integrates here; releases are cut from it. |
| `feat/<topic>` | Short-lived feature branches, **branched off `main`**, merged back via PR **into `main`**. |

## Workflow

1. Branch a feature off `main`: `git checkout -b feat/<topic> main`.
2. Commit with `git commit --no-verify` (skips the lefthook biome pre-commit so
   nothing runs locally — per the [operating constraints](../../CLAUDE.md)).
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

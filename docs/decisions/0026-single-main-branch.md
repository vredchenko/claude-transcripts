# 26. A single `main` branch

Date: 2026-06-18

## Status

Accepted

## Context

This is a fresh public **GitHub** repository — the clean rebuild starts its history
here, with no legacy branch to carry forward. It needs a simple, conventional
branch model that a public contributor (or the owner's future self) recognises
immediately.

## Decision

- **`main` is the single primary branch.** It is always releasable; CI (`ci.yml`)
  runs lint/typecheck/build on every push and PR to it.
- Work happens on short-lived **`feat/<topic>`** (or `fix/<topic>`) branches,
  merged back into `main` via **pull requests**.
- **Releases are cut from `main`** by pushing a `vX.Y.Z` tag
  ([ADR 0012](0012-github-actions-and-ghcr-for-releases.md)).

See [branching.md](../branching.md).

## Consequences

- The standard **GitHub flow** — no integration branch, no long-lived release
  branch — keeps contribution friction low and history easy to follow.
- The repo is developed locally until its GitHub remote is created; this model
  takes effect the moment `origin` exists.

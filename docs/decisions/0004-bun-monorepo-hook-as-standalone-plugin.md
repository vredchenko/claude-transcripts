# 4. Bun workspace monorepo; the hook ships as a standalone plugin

Date: 2026-06-06

## Status

Accepted

## Context

The project has two deliverables with different lifecycles: the **app**
(webapi + webui, deployed as a container) and the **hook** (a Claude Code plugin
installed on each machine that runs Claude Code, executed by Claude Code's hook
runner — not part of the container). They share one concept: the token-usage
accounting over a transcript.

The monorepo template established the structure: a Bun workspace monorepo
(`packages/*`), TypeScript throughout, Hono webapi, React 19 + Vite webui, Biome
+ lefthook, tag-driven releases.

## Decision

- Mirror the template skeleton: a Bun workspace monorepo with
  `packages/shared`, `packages/webapi`, `packages/webui`, plus root tooling
  (Biome, lefthook, shared `tsconfig.base.json`).
- Keep the **hook outside the workspace**, under `hooks/`, as a self-contained
  set of Bun scripts + a `.claude-plugin/plugin.json`. It is installed
  separately (`claude plugin install ./hooks`) and must run without resolving the
  monorepo's `node_modules`.
- Because of that, the token-summing logic is **duplicated**: the canonical copy
  is `packages/shared/src/index.ts` (`sumTranscriptTokens`), and
  `hooks/scripts/transcript-tokens.ts` is a byte-identical copy. Both files carry
  a "keep in sync" note.

## Consequences

- The app builds/tests as one workspace; the hook installs and runs standalone
  with only Bun as a prerequisite.
- The duplicated token logic is a known, deliberate trade (independence over DRY).
  A future option is publishing `@claude-transcripts/shared` so the hook can depend on it, but
  that adds a publish step not worth it in Phase 1.
- CouchDB design docs are likewise mirrored: `hooks/couchdb/` (synced by
  `setup-views.sh`) and `packages/webapi/src/storage/ensure.ts` (applied on boot).
  Either path can provision an empty database; the map functions must stay in sync.

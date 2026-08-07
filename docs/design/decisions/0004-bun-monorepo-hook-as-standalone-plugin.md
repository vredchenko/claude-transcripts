# 4. Bun workspace monorepo; the hook ships as a standalone plugin

Date: 2026-06-06

## Status

Accepted. Amended 2026-08-07 — see [Amendment](#amendment-the-duplication-is-gone).

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
  a "keep in sync" note. *(Superseded — see the amendment below.)*

## Consequences

- The app builds/tests as one workspace; the hook installs and runs standalone
  with only Bun as a prerequisite.
- The duplicated token logic is a known, deliberate trade (independence over DRY).
  A future option is publishing `@claude-transcripts/shared` so the hook can depend on it, but
  that adds a publish step not worth it in Phase 1.
- CouchDB design docs are likewise mirrored: `hooks/couchdb/` (synced by
  `setup-views.sh`) and `packages/webapi/src/storage/ensure.ts` (applied on boot).
  Either path can provision an empty database; the map functions must stay in sync.

## Amendment: the duplication is gone

*2026-08-07.*

The duplication above rested on one premise — "the hook must run without resolving the
monorepo's `node_modules`" — and that premise stopped being true when the **CLI became
the hook**. `claude-transcripts hook run` is what gets registered with Claude Code, and
an installed binary resolves `@claude-transcripts/shared` itself.

So `hooks/` no longer contains a writer. It is a shim: `scripts/dispatch.ts` pipes the
payload to `claude-transcripts hook run` and exits 0 whatever happens. The handlers, the
CouchDB and S3 clients, and the byte-identical copies of `sumTranscriptTokens` and the
chunking helpers were deleted — about 500 lines whose only remaining job was to be
identical to something else.

What the plugin costs now: it **requires the CLI to be installed**, since that is what
does the work. That's a real trade against the original "installs and runs standalone
with only Bun" consequence, and it's the right one — the plugin was never the primary
install path (`hook install` is), and a second implementation that must be kept
character-for-character in step with the first is a defect waiting for someone to edit
one file and not the other.

The rest of the ADR stands: the hook is still registered per machine, still outside the
webapi/webui runtime image, and still a pure observer that cannot fail a session.

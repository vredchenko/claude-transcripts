# 19. OpenAPI spec is the source of truth; clients are generated

Date: 2026-06-18

## Status

Accepted (supersedes [ADR 0006](0006-no-openapi-client-codegen-shared-types.md))

## Context

[ADR 0006](0006-no-openapi-client-codegen-shared-types.md) had the webui import
shared workspace **types** directly and skip OpenAPI client codegen — reasonable
when the only consumer was a webui living in the same monorepo.

That assumption no longer holds. Under [ADR 0016](0016-webapi-is-the-io-gateway.md)
the webapi is the single I/O gateway with **multiple** consumers: the webui, a
standalone **CLI** (Bun + Ink), and — in later tiers — third-party integrations
and AI agents. A shared-workspace-types approach only works for consumers that
live in the workspace and can import TypeScript source; it doesn't serve a CLI
that may ship as a standalone binary, nor external consumers.

## Decision

The **webapi's OpenAPI spec is the single source of truth for the API contract**,
and **typed clients are generated from it**.

- The webapi already defines routes with `@hono/zod-openapi`, so the OpenAPI
  document is authoritative and published (Swagger at `/api/docs`).
- The **webui** and **CLI** consume **generated** TypeScript API clients built
  from that spec — they do not hand-write request code or rely on importing
  server-internal types.
- Client generation is a build step; the generated client is the typed boundary
  every consumer shares.

## Consequences

- Adding a consumer (CLI today; external SDKs later) is "generate a client", not
  "re-implement requests" — consumers can't drift from the contract.
- The contract is enforced in one place; changing a route is caught at every
  consumer's compile/codegen step.
- `packages/shared` narrows to genuinely cross-cutting domain types/helpers (e.g.
  `sumTranscriptTokens`); request/response wire types come from the generated
  client, not hand-shared interfaces.
- Supersedes ADR 0006's "no codegen" stance. The byte-identical-copy invariant for
  `sumTranscriptTokens` (hook ↔ shared) is unaffected — that's a host-side helper,
  not part of the wire contract.
- Tooling choice (e.g. `openapi-typescript` / `openapi-fetch` or similar) is an
  implementation detail to be fixed when the CLI lands; see [cli.md](../cli.md).

# 6. Webui consumes shared workspace types directly; no OpenAPI client codegen

Date: 2026-06-06

## Status

Superseded by ADR 0019 — reversed; this rebuild adopts generated clients from the
start.

> The original decision (have the webui import shared workspace **types** and skip
> OpenAPI client codegen) was reversed by
> [ADR 0019](0019-openapi-source-of-truth-generated-clients.md). This is a fresh
> rebuild that adopts the final, reversed decision from the outset — generated
> clients — so the old "no codegen" stance is **not** in force here. This record
> is retained only so the ADR number resolves and the reversal is explicit.

## Context

A prior incarnation of this project held off on OpenAPI client codegen while the
webui was the only API consumer and lived in the same monorepo, importing shared
TypeScript types directly. Once the webapi became the single I/O gateway
([ADR 0016](0016-webapi-is-the-io-gateway.md)) with multiple consumers (the webui
**and** a standalone CLI, plus future external SDKs), that assumption no longer
held and the decision was reversed.

## Decision

This rebuild adopts **generated clients from the OpenAPI spec from the start**.
The webapi's OpenAPI document is the single source of truth for the API contract,
and typed clients are generated from it for every consumer (webui, CLI, future
SDKs). The earlier "do not use OpenAPI→client codegen" position is **explicitly
reversed** and does not apply here.

See [ADR 0019](0019-openapi-source-of-truth-generated-clients.md) for the full
reasoning behind the generated-clients decision.

## Consequences

- No hand-shared wire types or hand-written request code; consumers can't drift
  from the contract.
- This record exists only to mark the reversal and keep cross-references intact;
  ADR 0019 is the operative decision.

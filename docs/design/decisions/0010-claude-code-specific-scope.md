# 10. Claude-Code-specific scope (not a generic agent-session logger)

Date: 2026-06-06

## Status

Accepted

## Context

A tempting generalisation is to make this a vendor-neutral "AI/agent session
logger" that supports many products (Claude Code, other CLIs/IDEs, other model
vendors) behind an adapter layer. We explicitly choose **not** to.

Origin and usage shape this: the project started as **personal dev tooling**, and
the owner works almost exclusively in Claude Code.

## Decision

Target **Claude Code specifically**. The data model, hook wiring, and feature
extraction are built directly on Claude Code's own surface, not on a
lowest-common-denominator abstraction over "agents in general."

- **The valuable parts are Claude-specific.** Claude Code's hook events
  (`SessionStart`, `PostToolUse`, `SubagentStart`, …) and its transcript format
  are what make session-history feature extraction (token accounting, tool usage,
  subagent activity, prompts) possible and rich. An abstraction layer would have
  to erase exactly the details that give the features their value.
- **Adapters would add cost without payoff here.** Supporting a range of AI
  products via an adapter pattern adds overhead and complexity and *smears the
  feature surface*: a feature that works for Claude Code may be hard or impossible
  for another product, so the common denominator shrinks to the least capable
  target. For single-user, Claude-Code-first tooling that is a bad trade.
- **It reinforces the consumer loop.** This tool is also meant to be read back *by
  Claude Code* (see [ADR 0007](0007-couchdb-primary-store.md)); being native to
  Claude Code's own shapes makes that loop tighter, not harder.

Note the deliberate asymmetry: the **storage** layer *is* vendor-neutral (CouchDB,
any S3 via Bun's client — [ADR 0003](0003-vendor-neutral-s3-drop-minio-and-rclone.md),
[0008](0008-garage-s3-object-store.md)), but the **AI-product** layer is
intentionally *not*. We avoid lock-in where it's cheap (infra) and embrace
specificity where it pays (the Claude Code feature surface).

## Consequences

- Hooks, schemas, and extraction can use Claude-Code-native fields freely without
  guarding for other products.
- The project is coupled to Claude Code's hook/transcript surface, so upstream
  changes can break it — which is *why* tracking the latest Claude Code version
  and reporting drift is on the roadmap (README "Future scope").
- Supporting another AI product later would be a deliberate, scoped decision (and
  a superseding ADR), not an always-on abstraction tax paid up front.
- Naming, docs, and UX can speak "Claude Code" plainly rather than in
  generic-agent terms.

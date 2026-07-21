# 20. Bundled backing services default to no auth

Date: 2026-06-18

## Status

Accepted

## Context

Tier 1 is single-user, single-machine, localhost-only, with **no security
concern** by design ([ADR 0015](0015-tiered-architecture.md)). When the backends
are the project's **bundled** Docker Compose stack, requiring the operator to
generate and manage CouchDB passwords, an S3 access/secret key, and a Meilisearch
master key is pure setup friction for zero benefit — there is no untrusted party
on a localhost Tier-1 box.

## Decision

When the backends are the **bundled** stack (`deploy/`), they default to **no
authentication** — no tokens, keys, or passwords for the operator to supply:

- **CouchDB** runs without admin credentials ("admin party") — open on localhost.
- **Meilisearch** runs with **no master key**.
- **Garage (S3)** is provisioned with a **built-in default key baked into the
  compose stack** (the S3 protocol still signs requests, but the operator never
  generates or manages a credential — it ships pre-wired). This is the honest
  exception: "no credential the operator must provide", not literally keyless.
- The stack **binds to localhost only**; nothing is exposed off-box.

**External** backends are unaffected — they use whatever auth they're configured
with, supplied via `.env` (`COUCHDB_*`, `S3_*`, search keys). Real auth/security is
a **Tier 3** concern, introduced with the public/multiplayer release.

## Consequences

- Tier-1 install is "bring up the stack, register the hook" — no secret management.
- The webapi and hook must treat **empty/absent credentials as valid** for the
  bundled case (don't hard-require auth fields).
- The bundled compose **must not** bind backends to non-loopback interfaces; the
  no-auth posture is only safe on localhost. Document this prominently in
  `deploy/`.
- Moving to external/exposed backends means turning auth **on** — that transition
  is part of the Tier-3 security work, not a silent default.

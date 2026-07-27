# 9. Meilisearch for search (Phase 2)

Date: 2026-06-06

## Status

Proposed — search is Phase 2 and not yet wired up. Meilisearch is provisionally
included in the `deploy/` stack; the choice will be confirmed (including a
Typesense evaluation, see Alternatives) before the search layer is built.

## Context

Phase 1 deliberately excludes search (see README). But the stack reserves a
search engine now so the architecture accounts for it. The corpus is the session
log in CouchDB (transcripts, events, summaries) and, in future, content from
*outside* this stack worth searching as Claude Code context.

## Decision

Provisionally adopt **Meilisearch** as the search engine, kept as a **loosely
coupled, optional** component.

- **Fast, FOSS (MIT), lightweight, typo-tolerant typeahead out of the box** — the
  search UX is built-in, not something we assemble.
- **Loosely coupled / swappable both ways.** Meilisearch is an *index built from*
  CouchDB, not a system of record. Drop it and only search stops working — the
  rest of the stack runs unchanged. It's also itself swappable, and its presence
  doesn't constrain swapping other parts of the stack. CouchDB/Garage remain the
  source of truth.
- **Can index beyond the CouchDB/Garage corpus.** The forward-looking win: a
  single search layer over *additional* context sources that live outside this
  stack — GitHub, Jira, git history, codebases, external tech docs, etc.
- **Programmatic, Claude-Code-facing search.** Beyond human content search, it
  can back queries optimised for consumption *by Claude Code itself*. It exposes
  an HTTP API + official SDKs (and a built-in search-preview UI), making it
  straightforward to surface to Claude Code programmatically — and browsable
  without this project's custom webui (same rationale as CouchDB/Garage).

## Alternatives considered

- **Postgres full-text search** — rejected: we don't run Postgres, so it would
  add a database purely for search.
- **Elasticsearch / OpenSearch** — rejected: a heavy multi-component stack, and
  much of its store-and-query value is redundant since the logs already live in
  CouchDB.
- **CouchDB-native FTS (Mango `_find`, or Lucene/Nouveau)** — viable for searching
  the CouchDB corpus, but couples search tightly to the DB and doesn't extend to
  the external sources above; a dedicated, decoupled engine is preferred.
- **Typesense** — a credible peer (FOSS, lightweight, typo-tolerant, vector
  search). **Not yet evaluated.** Trade-offs vs Meilisearch: GPLv3 (vs MIT);
  RAM-resident index (faster, but heavier RAM) vs Meilisearch's disk-backed LMDB
  (lighter footprint — better for homelab nodes); more mature built-in clustering.
  To be benchmarked before the Phase-2 search work is committed; if it wins, this
  ADR is superseded.

## Consequences

- The `deploy/` stack runs Meilisearch but nothing reads/writes it yet (Phase 1).
- When built, an indexer projects CouchDB (and later external sources) into
  Meilisearch; the index is rebuildable from the sources of truth and disposable.
- Because it's optional, deployments that don't want search can simply not run it.
- Status stays `Proposed` until the search layer is implemented (and Typesense
  evaluated); confirming it is a status bump, switching is a superseding ADR.

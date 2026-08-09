# 9. Meilisearch for search (Phase 2)

Date: 2026-06-06

## Status

**Accepted** — the search layer is built and running on Meilisearch. `GET /api/search`
serves session-metadata and conversation-content hits; the indexes are kept current by
a CouchDB `_changes` follower and rebuildable with `POST /api/search/reindex`.

The Typesense evaluation below never happened — Meilisearch was implemented directly.
That's a decision by default rather than by comparison; switching now would be a
superseding ADR, and the fact that the index is disposable and rebuilt from CouchDB is
what keeps that cheap. Whether the engine may live **outside** the bundled stack is
open: [ADR 0028](0028-external-vs-bundled-meilisearch.md).

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

- Two indexes are projected from CouchDB — named `sessions` and `turns` at the time,
  since namespaced to `claude-transcripts-*` ([ADR 0028](0028-external-vs-bundled-meilisearch.md)): one doc per `summary` and
  `turns` (one doc per full-content `chunk` entry). Both are **disposable** — nothing
  in them is authoritative, and `reindex` rebuilds them from the store.
- Because it's optional, deployments that don't want search can simply not run it:
  every Meilisearch call is best-effort, and search degrades to `enabled: false`
  rather than erroring.
- "Rebuildable and disposable" turned out to be load-bearing in practice, not just
  theory: it's what let a silent indexing bug be fixed by a rebuild rather than a data
  migration.
- Being a derived index rather than a store is also what makes it *harder* to
  externalise than CouchDB or Garage — see [ADR 0028](0028-external-vs-bundled-meilisearch.md).
- Indexing must never block or break a write. That constrains the write path: it can't
  wait on Meilisearch's asynchronous validation, so index-level failures are invisible
  there by design and surface through `reindex` instead.

## Where indexing happens (Tier 1)

Worth stating plainly, because "search" often implies something leaving the machine and
here it doesn't.

- **Optional, on by default.** `features.meilisearch` gates it. Off means no indexing,
  no index, and a search box that says so — the corpus is unaffected either way, since
  everything in Meilisearch is derived from CouchDB.
- **Local-only, like the webapi.** The bundled stack publishes Meilisearch on
  `127.0.0.1:7656`, the same posture as the webapi's `127.0.0.1:7650` — not reachable
  from another machine ([ADR 0020](0020-bundled-services-default-no-auth.md)).
- **Indexed on the user's side.** The **webapi** is the only thing that writes to
  Meilisearch: it follows CouchDB's `_changes` feed and pushes documents, and the ingest
  routes index as they write. The webapi runs on the same machine as the data, so
  indexing is a local read of a local store followed by a local write. The hook never
  touches Meilisearch at all.
- **Surfaced through the webapi and webui.** `GET /api/search` and the webui's search
  box + `/search` page are the interfaces; the CLI drives `reindex`.

### The caveat that comes with ADR 0028

[ADR 0028](0028-external-vs-bundled-meilisearch.md) makes an **external** Meilisearch
supported and safe from a *collision* standpoint. It does not make it private: the
`turns` index holds **conversation text**. Point `MEILI_HOST` at another host and
transcript content goes there — the one configuration in which this project's data
leaves the machine it was recorded on.

That's a legitimate thing to want and an easy thing to do by accident, so it belongs
next to the decision that enabled it rather than only in the ADR that discussed
namespacing. The bundled instance remains the default precisely because it has this
property by construction.

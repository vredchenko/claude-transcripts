# 28. External vs bundled Meilisearch

Date: 2026-07-30

## Status

**Open — undecided.** Recorded now so the dilemma is written down while it's
understood; no option is adopted yet. Today Meilisearch is bundled in `deploy/`, and
that remains the status quo until this ADR is decided.

## Context

The backing services differ in how *portable* they are, and that difference is not
obvious until you try to move one.

**CouchDB and Garage are addressable stores.** Point `COUCHDB_URL` / `S3_ENDPOINT` at
somewhere else — a NAS, a managed CouchDB, another host's Garage — and the app works.
They hold state we send and give back what we ask for; the app doesn't care where they
run. Running them externally is already supported: the bundled stack is a convenience,
not an assumption ([ADR 0020](0020-bundled-services-default-no-auth.md)).

**Meilisearch is not a store — it's a derived index**, and that makes it different in
kind. Nothing in it is authoritative: everything is a projection of CouchDB
([ADR 0009](0009-meilisearch-search.md)). Making it external means exporting more than
a URL:

- **It has to be configured, not just connected.** Indexes must exist with the right
  `primaryKey`, `searchableAttributes`, `filterableAttributes` and `sortableAttributes`
  before a document lands. The webapi does that at boot (`ensureIndex`), so it has to
  own settings on a server it doesn't own.
- **It has to be fed continuously.** The webapi follows CouchDB's `_changes` feed and
  pushes documents; an external Meilisearch means that stream crosses a network the
  deployment may not control, with the failure modes that implies.
- **Its contents are ours.** Index names (`sessions`, `turns`), document shapes and id
  scheme are internal implementation detail. On a shared external instance, two
  Claude Transcripts deployments would collide on index names, and a rebuild
  (`POST /api/search/reindex`) *clears the index* — destructive to anything else using
  that name.
- **Multi-tenancy is the real question.** The plausible reason to externalise is a
  Meilisearch already running for other things. That instance likely has a master key,
  other indexes, and other clients — the opposite of the bundled no-auth localhost
  assumption we currently build on.

So the awkwardness is real and worth naming: for the stores, "external" is a URL; for
the index, "external" is a shared, stateful, configured dependency with a lifecycle we
partly drive.

There's a further wrinkle: [ADR 0009](0009-meilisearch-search.md) anticipates indexing
sources *beyond* this stack (GitHub, git history, external docs). That future argues
*for* a shared external instance — which is exactly the case that's hardest to isolate.

## Options

1. **Bundled only (status quo).** Meilisearch stays part of `deploy/`, no auth,
   localhost. Simple, isolated, disposable; rebuilds are safe because nothing else uses
   it. Rules out reusing an existing instance.
2. **External, namespaced.** Support `MEILI_HOST` + `MEILI_API_KEY` pointing anywhere,
   and prefix index names per deployment (e.g. `<instance>_sessions`). Removes the
   collision and makes a destructive rebuild safe. Costs a config surface (instance id),
   a migration for existing index names, and key/permission handling.
3. **External, bring-your-own-index.** The operator creates and configures the indexes;
   we only read and write documents, never settings, and never clear. Safest for a
   shared instance, but moves setup burden onto the operator and makes our settings
   documentation normative rather than executable.
4. **Pluggable search backend.** Treat Meilisearch as one implementation behind a
   small interface (index/search/rebuild), so an external engine — or Typesense, or
   none — is a config choice. The most flexible and the most work; only worth it if a
   second backend is actually wanted.

## Decision

None yet. To decide when there's a concrete need — someone wanting to point this at an
existing Meilisearch, or the ADR 0009 "index external sources" work starting, whichever
comes first.

Deciding will need: whether per-deployment index prefixes are wanted regardless (they
also help local dev against one shared engine); how API keys and scoped permissions fit
the currently auth-free bundled assumption; and whether `reindex`'s clear-then-rebuild
can stay destructive if the index might not be exclusively ours.

## Consequences

- Until decided, treat the bundled instance as the supported configuration; external
  Meilisearch may happen to work but isn't a promise, and the destructive rebuild makes
  pointing at a shared instance actively unsafe today.
- Code should avoid hard-coding the assumption that we exclusively own the engine —
  index names already flow from constants in one module, which keeps option 2 cheap.
- Nothing here blocks running **CouchDB or Garage** externally; that stays supported.

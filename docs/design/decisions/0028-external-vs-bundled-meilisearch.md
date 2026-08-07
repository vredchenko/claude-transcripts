# 28. External vs bundled Meilisearch

Date: 2026-07-30

## Status

**Accepted (2026-08-07): option 2, external and namespaced** — see
[Decision](#decision). The bundled instance remains the *default* and the configuration
we test; pointing at an external one is now safe rather than merely likely to work.

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

**Adopt option 2: external, namespaced.**

What settled it wasn't the multi-tenancy question in the abstract — it was noticing an
inconsistency the codebase already contained. CouchDB databases and S3 buckets are named
in `config/` as keyed maps (`claude-transcripts-sessions`), deliberately, because "the
app supports multiple databases and buckets". Meilisearch's indexes were bare
hard-coded constants: `"sessions"` and `"turns"`.

Those are the most collidable names imaginable, and `reindex` **clears the index before
rebuilding**. Anyone who set `MEILI_HOST` to an existing Meilisearch — which the config
has always allowed — could destroy someone else's `sessions` index by running a
supported command. The dangerous option wasn't "go external"; it was the status quo,
which permitted going external while quietly assuming nobody would.

So the index names move into `config/` as `meilisearch.indexes`, exactly like the
databases and buckets, defaulting to `claude-transcripts-sessions` and
`claude-transcripts-turns`. That is the whole of option 2 that Tier 1 needs:

- **Collisions become impossible by default** — the names are as namespaced as every
  other store's, and an operator who wants different ones edits config.
- **`reindex` can stay destructive**, because it can only clear indexes this deployment
  named.
- **`MEILI_API_KEY` already existed** and now means something: an external instance with
  a master key works.

Deliberately *not* adopted:

- **Option 3 (bring-your-own-index)** — it makes our index settings documentation
  normative instead of executable, and `ensureIndex` at boot is a real convenience.
- **Option 4 (pluggable backend)** — no second backend is wanted. Building the
  abstraction now would be paying for optionality nobody has asked for.

### Migrating an existing instance

Nothing in Meilisearch is authoritative, so there is no data migration. An instance
running before this change has indexes literally named `sessions` and `turns`; after it,
the app reads and writes the namespaced names. Run `claude-transcripts reindex` to
populate them, then delete the two old indexes if you want the space back. A deployment
whose `config.json` predates the `meilisearch` key gets the defaults, so it keeps
working without being edited.

## Consequences

- The bundled instance stays the **default and the tested configuration**. External is
  now *safe*, not *equally exercised* — and the honest way to say that is that we test
  what we ship.
- Index names are configuration, so a shared engine can host several deployments, and
  local dev can point at one engine without stepping on an install.
- `reindex` keeps its clear-then-rebuild, which is only defensible because the uid it
  clears is one this deployment named.
- Still open, and deferred until someone actually needs it: **scoped API keys**. A
  master key gives us the whole engine, which is more than we need on an instance we
  don't own. Meilisearch supports tenant tokens; wiring them is work with no demand yet.
- The ADR 0009 "index external sources" direction is unblocked rather than resolved —
  namespacing is a precondition for it, not an answer to it.
- Nothing here blocks running **CouchDB or Garage** externally; that stays supported.

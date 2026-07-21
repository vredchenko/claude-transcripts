# Database & search-engine choice

A standing assessment of the two backing-technology choices the owner asked to
keep under review: the **document store** (currently CouchDB) and the **search
engine** (currently Meilisearch). Constraint: **do not consider MongoDB,
Elasticsearch, or PostgreSQL** as replacements.

> TL;DR: **keep CouchDB** — it is unusually well-suited to this design. **Keep
> Meilisearch for lexical/human search**, but expect Tier-2 agent retrieval to
> want a **vector index** (Qdrant or LanceDB) behind the same webapi search
> abstraction. Both stay swappable because everything goes through the webapi.

## Document store — keep CouchDB

CouchDB is not just adequate here; several of its defining traits are *load-bearing*
for the architecture:

1. **Its API is HTTP + JSON.** The `/api/couch` read-only proxy
   ([routes.md](routes.md), [ADR 0016](decisions/0016-webapi-is-the-io-gateway.md))
   is trivial and honest precisely because CouchDB's native interface already *is*
   a RESTful document API. With a store whose protocol isn't HTTP, "expose the DB
   as part of our API surface" would mean re-implementing CRUD.
2. **Masterless multi-master replication *is* the Tier-3 multiplayer model.**
   Bi-directional, conflict-tolerant replication between nodes is a built-in, not a
   bolt-on. Nothing else in the allowed set offers it natively. The append-only /
   immutable document rule in Tier 1 exists to make this conflict-free
   (#15).
3. **`_changes` feed** gives a clean tail to drive derived indexes (Meilisearch /
   vectors) and reactive consumers.
4. **Map-reduce design views** do the feature extraction (events of interest, token
   rollups, content features) close to the data.
5. **Schemaless + append-only** fits a heterogeneous event/summary/chunk corpus and
   the immutability rule.

**Known weaknesses (and why they're acceptable):** map-reduce JS views are clunky
and ad-hoc querying is limited — **Mango** indexes cover the common cases, and the
webapi owns any richer query logic. Operational footprint is real but modest at
Tier-1 scale. Heavy analytical aggregation is not CouchDB's strength (the
observability tools we studied reach for columnar stores like ClickHouse at large
scale) — noted as a **scale ceiling** for the Tier-2 analytics work, not a Tier-1
problem.

**Alternatives weighed (within the constraint):**

- **SQLite / libSQL** — great single-machine footprint, but loses the HTTP-native
  proxy story *and* masterless replication; pushes more logic into the webapi.
  Several competitors (Phoenix, claude-mem, claude-self-reflect) prove the
  single-file-DB approach for *local single-user* tools — exactly the niche where
  our replication/HTTP advantages don't pay off, so it validates CouchDB for our
  *server/multiplayer* aim rather than displacing it.
- **SurrealDB** — multi-model with HTTP/WS + live queries; interesting, but
  heavier/younger and its replication story doesn't match CouchDB's masterless
  model. Not worth a switch.
- **RethinkDB** — changefeeds are nice but the project is effectively dormant.
- **PouchDB** — not a replacement but a *complement*: CouchDB's replication
  protocol means an embedded/offline PouchDB client stays open as a future edge
  path. Worth remembering for Tier 3.

**Verdict: keep CouchDB.** Revisit only if Tier-2 analytics hit the aggregation
ceiling — and even then the answer is likely an *added* analytical/derived store,
not replacing the source of truth.

## Search engine — keep Meilisearch, plan for vectors

Meilisearch fits the **human + lexical** search need well: fast, typo-tolerant,
easy to self-host, good DX, and recent **hybrid (lexical + vector)** support. As a
**per-node derived index fed by `_changes`** (not replicated, rebuildable from
CouchDB) it matches the intended design, and ADR 0009 already keeps it `Proposed`.

But Tier-2's "agents recall / self-learn from history" is fundamentally a
**semantic retrieval** workload, and the competitor study is clear that this lane
reaches for **dedicated vector stores**: Mem0/claude-mem use Qdrant/Chroma, Reor
uses LanceDB, basic-memory/claude-self-reflect use FastEmbed + local vectors,
Graphiti pairs vectors with a temporal graph. Meilisearch's hybrid mode may not be
enough for that.

**Recommendation:**

- **Keep Meilisearch** as the lexical/human search backend (or swap for
  **Typesense** — a near drop-in with comparable hybrid/faceting; the pending
  ADR 0009 eval).
- **Expect to add a vector index** (lean **Qdrant** for a service, or **LanceDB**
  for an embedded/low-footprint option) for Tier-2 agent retrieval, possibly
  alongside Meilisearch.
- **Keep all of it behind a webapi `/api/search` abstraction** so the engine is
  swappable and consumers never bind to a specific backend
  ([ADR 0016](decisions/0016-webapi-is-the-io-gateway.md)). The derived-index
  design already assumes it rebuilds from CouchDB, so swapping/adding is cheap.

See [competitive-landscape.md](competitive-landscape.md) for the evidence behind
the search/vector reasoning.

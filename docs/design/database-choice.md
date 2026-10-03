# Database and search choices

**Keep CouchDB as the store. Keep Meilisearch for lexical search, and expect to add a
vector index for agent recall.** Both stay swappable because every consumer goes
through the webapi. MongoDB, Elasticsearch and PostgreSQL were ruled out from the
start.

## CouchDB

Several CouchDB traits carry weight in this design
([ADR 0007](decisions/0007-couchdb-primary-store.md)):

- **Its API is HTTP + JSON**, so the read-only `/api/couch` proxy is a passthrough
  rather than a reimplementation.
- **Masterless replication** is the Tier 3 multiplayer model, built in. The
  append-only document rule exists to keep it conflict-free.
- **The `_changes` feed** drives derived state (search, the session index).
- **Map/reduce views** aggregate close to the data; schemaless docs fit a mixed
  event/summary/chunk corpus.

Weaknesses: JavaScript views are clunky and ad-hoc queries limited (Mango covers common
cases; richer logic lives in the webapi), and heavy analytics is not its strength. If
Tier 2 analytics hit that ceiling, the answer is an added analytical store, not a
replacement.

Considered: SQLite/libSQL (small footprint, but no HTTP API or replication; fine for a
local-only tool, which this isn't aiming to stay), SurrealDB (younger, different
replication model), RethinkDB (dormant). PouchDB is a possible future complement for
offline clients, since it speaks CouchDB's replication protocol.

## Meilisearch

Fast, typo-tolerant, easy to self-host, and run as a per-node index derived from
CouchDB rather than replicated ([ADR 0009](decisions/0009-meilisearch-search.md)).
Typesense would be a near drop-in alternative; it was never evaluated.

Agent recall is a semantic retrieval workload, and the projects below that do it reach
for vector stores (Qdrant, Chroma, LanceDB). Meilisearch's hybrid mode may not be
enough, so expect a vector index (Qdrant as a service, or LanceDB embedded) behind the
same `/api/search`, rebuilt from CouchDB like the rest.

## Prior art

A survey of twelve open-source projects (June 2026; per-project notes in issues
#18–#29, indexed by #30):

| Project | Store | Memory model | Recall interface | Keeps raw transcript? |
|---------|-------|--------------|------------------|------------------------|
| claude-mem | SQLite + Chroma | compressed summaries | MCP + hooks | no |
| claude-self-reflect | SQLite (Rust) | embeddings + decay | MCP | imports `.jsonl` |
| Mem0 | vector (+ graph) | reconciled facts | SDK/REST/MCP | no |
| Letta | Postgres/pgvector | RAM/disk tiers | tool calls | yes (messages) |
| Zep/Graphiti | graph DB | bi-temporal graph | REST/MCP | source episodes |
| Cognee | vector + graph | graph + vectors | SDK | no |
| Basic Memory | markdown + SQLite | observation/relation graph | MCP | no |
| Khoj | Postgres + pgvector | RAG over documents | web/REST | n/a |
| Reor (archived) | LanceDB | similarity | desktop app | n/a |
| Langfuse | Postgres + ClickHouse + S3 | trace/observation | SDK/REST/UI | inputs/outputs |
| Arize Phoenix (ELv2) | SQLite/Postgres | OTel spans | GraphQL/REST/UI | spans |
| Laminar | Postgres + ClickHouse + Qdrant | spans | SQL/SDK/UI | spans |

What it means for this project:

- Most memory tools keep distilled facts and discard the transcript. Keeping the
  transcript as ground truth, with distillation as an optional derived layer, gives
  recall with provenance.
- Recall ideas worth borrowing without their stores: Mem0's add/update/delete
  reconciliation, Graphiti's bi-temporal validity, Letta's background reflection,
  Basic Memory's reflection skills.
- MCP is the common recall surface; the plugin starts with skills and keeps MCP as an
  option ([plugin.md](plugin.md#part-2--skills)).
- Langfuse's observation → trace → session hierarchy is a useful reference vocabulary.

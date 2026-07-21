# Competitive landscape

A survey of open-source projects in the AI-memory / LLM-session-logging /
self-learning-agent space, mapped to inform our design. Detailed per-project
reports live as GitHub issues (**#18–#29**), indexed by **#30**; this doc is the
synthesis and the "where we sit" conclusions.

> Surveyed 2026-06-18 across four lanes (agent-memory frameworks · personal/second
> -brain · LLM observability · coding-agent memory), deduplicated to 12 projects.
> Facts verified against the repos at survey time; star counts/versions drift.

## The twelve

**Direct competitors — Claude Code / coding-session capture + recall**
- **claude-mem** (#18) — session capture + AI-compressed recall via MCP + hooks; ~83k★, closest large competitor.
- **claude-self-reflect** (#19) — Claude Code recall via MCP; single Rust binary + SQLite; memory decay.

**Agent long-term memory frameworks**
- **Mem0** (#20) — extract facts → ADD/UPDATE/DELETE reconcile → retrieve.
- **Letta / MemGPT** (#21) — stateful self-managing agents; RAM/disk tiers; sleep-time reflection.
- **Zep / Graphiti** (#22) — bi-temporal knowledge graph; LLM-free hybrid retrieval; strong provenance.
- **Cognee** (#23) — hybrid vector+graph "ECL" ingestion pipeline.

**Personal / self-hosted "second brain"**
- **Basic Memory** (#24) — MCP-native markdown memory; Observation/Relation graph; reflection skills — our nearest neighbour.
- **Khoj** (#25) — flagship self-hosted second brain; pgvector-in-Postgres; many surfaces.
- **Reor** (#26) — local-first RAG-over-notes; LanceDB + Transformers.js (archived; reference architecture).

**LLM observability / session-logging platforms**
- **Langfuse** (#27) — most popular OSS LLM observability; observation→trace→session; Postgres+ClickHouse+S3.
- **Arize Phoenix** (#28) — OTel-native; SQLite-simple self-host (⚠️ ELv2, not OSI-open).
- **Laminar / lmnr** (#29) — agent-first; SQL editor + Qdrant semantic search over traces; Apache-2.0.

## How they store & recall (at a glance)

| Project | Store | Memory model | Recall interface | Keeps raw transcript? |
|---------|-------|--------------|------------------|------------------------|
| claude-mem | SQLite + Chroma | compressed summaries | MCP + hooks | no (lossy) |
| claude-self-reflect | embedded SQLite (Rust) | embeddings + decay | MCP | imports `.jsonl` |
| Mem0 | vector (+graph) | reconciled facts | SDK/REST/MCP | no |
| Letta | Postgres/pgvector | RAM/disk tiers | tool calls / ADE | yes (messages) |
| Zep/Graphiti | graph DB | bi-temporal graph | REST/MCP | source episodes |
| Cognee | vector + graph | ECL graph+vectors | SDK | no |
| Basic Memory | markdown + SQLite | Observation/Relation graph | MCP | no (distilled) |
| Khoj | Postgres + pgvector | RAG over docs | web/REST/plugins | n/a (docs) |
| Reor | LanceDB (embedded) | similarity | desktop only | n/a (notes) |
| Langfuse | Postgres+ClickHouse+S3 | trace/observation | SDK/REST/UI | inputs/outputs |
| Phoenix | SQLite/Postgres | OTel spans | GraphQL/REST/UI | spans |
| Laminar | PG+ClickHouse+Qdrant | spans + NL events | SQL/SDK/UI | spans |

## Where we sit — conclusions for our design

1. **Our moat is lossless, vendor-neutral capture.** Nearly every memory tool
   stores *distilled* facts/notes and discards the transcript. We keep the
   **byte-faithful transcript (CouchDB + S3)** as ground truth; distillation is an
   *optional derived layer* on top — agents get recall **and** provenance.
2. **Borrow the recall model, not the dependency.** Mem0's **ADD/UPDATE/DELETE
   reconciliation**, Graphiti's **bi-temporal validity + provenance**, Letta's
   **sleep-time reflection**, and basic-memory's **reflection/defragmentation
   skills** are all adaptable over our corpus without adopting their stores. (Take
   Graphiti's temporal model, not Neo4j.) These feed the Tier-2 "self-learn from
   history" work ([tiers.md](tiers.md)).
3. **Search will want vectors (Tier 2).** The recall lane reaches for vector
   stores (Qdrant/LanceDB/FastEmbed). Meilisearch covers lexical/human search;
   agent semantic retrieval likely needs a vector index behind the webapi
   `/api/search` abstraction — see [database-choice.md](database-choice.md).
4. **Session data model:** adopt Langfuse's **observation → trace → session**
   vocabulary as the reference for our event→session hierarchy.
5. **Stay lightweight on purpose.** Langfuse/Laminar run 3–4 backing services for
   scale; Phoenix shows SQLite-simple is viable. Our CouchDB + S3 is the
   deliberate middle — with a known **analytics scale ceiling** for Tier-2
   dashboards.
6. **MCP is the dominant agent-recall surface** (claude-mem, basic-memory, Mem0,
   Graphiti all ship one) — a strong signal for how we eventually expose history
   to live sessions (the roadmap recall plugin, [#10](roadmap.md)). Phoenix's
   GraphQL reader and Laminar's SQL-over-history are power-user ideas for our
   webapi.
7. **Licensing:** Apache-2.0/MIT dominate the projects we'd emulate; Phoenix's
   **ELv2** is the cautionary contrast for our public release.

# Storage backend evaluation — CouchDB, Fossil, and the alternatives

**Status:** working notes, not an ADR. Nothing here has been committed to a decision;
it exists to be argued with. If any of it survives review it should be promoted into
[`database-choice.md`](database-choice.md) or an ADR amending it.

**Constraint carried over from [`database-choice.md`](database-choice.md):** MongoDB,
Elasticsearch and PostgreSQL are out of scope as replacements for the document store.

## The questions

This document is the answer to four questions, each reproduced at the head of the part
that answers it. They were asked conversationally and are lightly tidied here — filler
words removed, wording otherwise left alone.

1. Is CouchDB read-optimized, and therefore wrong for streaming logs? — [Part 1](#part-1--is-couchdb-read-optimized)
2. Would swapping CouchDB for Fossil be worth it? — [Part 2](#part-2--fossil-in-place-of-couchdb)
3. A brief on each alternative service named — [Part 3](#part-3--service-briefs)
4. Application logs: filesystem, then rotate to Garage? — [Part 4](#part-4--application-logs--filesystem--garage)
   · DuckDB + Parquet + Garage in detail — [Part 5](#part-5--duckdb--parquet--garage-in-detail)
   · The vector slot, compared — [Part 6](#part-6--the-vector-slot-compared)

> **Note on Part 4.** It revises a recommendation made in Part 3. The VictoriaLogs brief
> there is superseded by the filesystem-to-Garage design; both are left in place so the
> reasoning is visible rather than tidied away.

---

## Part 1 — Is CouchDB read-optimized?

> Would it be fair to say that CouchDB is optimized for read rather than for write? And
> if I'm just pumping logs into that, streaming, and then it does a lot of design views
> and upserts — then it's not the best storage backend for such a use case. And what
> would be a storage backend for such a use case, optimized for write, and then maybe
> for read after?

### The premise, corrected

The premise is half right, and the half that's wrong matters more.

CouchDB's storage engine is an **append-only B+tree with MVCC**. Writes append to the end
of the file, rewrite the b-tree path from leaf to root, and fsync a header. That is
sequential I/O — structurally *not* a read-favouring design. And the reads are not
especially fast either: no columnar layout, no aggregation pushdown beyond map-reduce
`_reduce`, limited ad-hoc querying.

What CouchDB actually optimizes for is **replication and crash-safe document identity**.
Nearly everything expensive about it — per-document `_rev` history, quorum writes across
shard replicas, the `_changes` by-seq index — is rent paid for masterless multi-master
sync. That is precisely why [`database-choice.md`](database-choice.md) keeps it:
replication *is* the Tier-3 multiplayer model, and nothing else in the allowed set offers
it natively.

So the accurate framing is: CouchDB is neither read- nor write-optimized. It is
**sync-optimized**, and both the read and write paths pay for that.

### Where it genuinely hurts on a write stream

Three real mechanisms. Worth being precise about which ones actually bite here.

**1. Per-document cost.** One HTTP request, one JSON parse, one Erlang process, one
b-tree path rewrite, one fsync. Delayed commits were deprecated in 2.x and removed in
3.0, so there is no batching for free. Single-document `PUT`s land in the
hundreds-to-low-thousands per second range on good hardware. `_bulk_docs` amortizes the
fsync and the b-tree update and is commonly 10–100× faster.

> **This repo writes single documents.** `packages/cli/src/hook/runtime.ts:78` (`POST`)
> and `:90` (`PUT`). No `_bulk_docs` anywhere in `packages/` or `hooks/`.

**2. View indexing amplification, paid by the reader.** Every write dirties every design
doc's index. Views build incrementally, but with `update=true` (the default in 2.x/3.x)
the indexer is triggered *on read* — so a burst of writes leaves a backlog and the next
reader pays the latency. JavaScript views are evaluated by `couchjs`, a separate OS
process, with documents marshalled as JSON over stdio. Cost scales with
(documents × design docs), not (documents × views).

> **This repo has 8 design docs / 18 JS map views:** `_design/chunks`, `sessions`,
> `events`, `tools`, `activity`, `session_meta`
> (`packages/shared/src/migrations/designs.ts`), plus `_design/session_index`
> (`session-index.ts`) and `_design/speaker_split` (`speaker-split.ts`). That is 8
> `couchjs` passes per document.

This is the cost the original question was reaching for, and it is the real one.

**3. Compaction.** Append-only means the file grows monotonically until compacted, and
compaction rewrites the entire database file — needing roughly 2× headroom while
competing with live I/O. CouchDB also has **no TTL**: expiring data means a delete sweep
*plus* a compaction.

### Measured reality for this repo

The write rate is nowhere near any of those ceilings:

| Path | Rate |
|---|---|
| Chunk flush | ≤ 4/min per session — batched at 200 entries **or** 15 s (`config/config.template.json:7`) |
| Event docs | Light markers, a few per turn |
| Summary doc | 1 per session |
| Realistic peak | Single-digit writes/sec, single user, single machine |

CouchDB absorbs that with roughly three orders of magnitude to spare. The ceiling this
project will actually hit first is **analytical aggregation on read** — which
[`database-choice.md`](database-choice.md) already names as the Tier-2 scale ceiling.

But one measurement from [`bundles.md`](bundles.md) is worth staring at:

> **9.7 MB of live data across 7,090 docs, in a 92.7 MB file.**

That is ~9.5× bloat from append-only writes with no compaction running. Not a reason to
change databases. A reason to configure `[compaction_daemon]`. It is also the cheapest
performance work currently available.

### The write-optimized backend already exists, and it isn't CouchDB

[ADR 0014](decisions/0014-transcripts-live-in-s3-only.md) and
[ADR 0027](decisions/0027-full-content-chunks-in-couchdb.md) already put the
byte-faithful transcript in a local JSONL file that Claude Code appends to, escrowed to
S3 as a blob at `SessionEnd`. **That is the write-optimized path** — sequential append,
no index, no parse, no network. CouchDB holds a *projection* of it: metadata documents
plus parsed content chunks.

The architecture is therefore already CQRS-shaped. Which reframes the question. It is not
"is CouchDB a good write sink" — it isn't one, and isn't asked to be. It is "**is CouchDB
a good serving store**", and if it ever stops being one, the serving store gets swapped
without touching ingest. The `_changes` → Meilisearch pipeline
(`packages/webapi/src/storage/search-follower.ts`) is that pattern already working.

### What write-first-read-later actually looks like

The shape is **LSM-tree or columnar**: write to a memtable plus WAL, flush sequentially to
immutable segments, merge in the background. Writes are cheap because read structure is
built *afterwards*, off the write path.

Ranked for this project:

1. **DuckDB over Parquet in Garage** — best fit. Zero new services, reuses the object
   store already deployed. Detailed in [Part 5](#part-5--duckdb--parquet--garage-in-detail).
2. **ClickHouse** — the observability industry's answer, and already named in
   [`database-choice.md`](database-choice.md) as the escape hatch.
3. **A log in front (NATS JetStream / Redpanda)** — the classic "optimize for write" move
   is not a different database at all. Over-engineering at Tier 1; the JSONL file already
   plays this role.
4. **SQLite / libSQL in WAL mode** — genuinely faster than CouchDB at small writes.
   Rejected in [`database-choice.md`](database-choice.md) on architecture, not
   performance. That rejection stands.

### What to change now, in order of payoff

1. **Move the app-logs database off CouchDB.** See
   [Part 4](#part-4--application-logs--filesystem--garage) for the design.
2. **Use `_bulk_docs` in the hook.** A chunk flush writes several documents; batching them
   is one fsync instead of N. Small change at `packages/cli/src/hook/runtime.ts:78`.
3. **Watch the JS-view tax.** Mango indexes are evaluated natively in Erlang and skip
   `couchjs` entirely — worth converting the views that are really just lookups. Move
   genuinely analytical projections to a derived store rather than adding a 9th design doc.
4. **Schedule compaction.** See the 9.7 MB / 92.7 MB number above. Content chunks
   ([ADR 0027](decisions/0027-full-content-chunks-in-couchdb.md)) make the corpus grow
   considerably faster than metadata-only did.

---

## Part 2 — Fossil in place of CouchDB

> I would like you to evaluate swapping CouchDB for Fossil.

**Verdict: no.** But the instinct behind the question is sound, and it points at a real
option that isn't Fossil.

### The honest case for it

Fossil is genuinely well-matched on five axes, which is why it deserves a real evaluation
rather than a reflex:

- **Immutable, content-addressed artifacts** — matches the "append-only / immutable docs,
  never edit in place" invariant exactly, rather than approximately.
- **Built-in HTTP sync between clones** — this is the single property keeping CouchDB per
  [`database-choice.md`](database-choice.md), and Fossil has it natively.
- **Single-file SQLite footprint** — one executable, one file. No Erlang runtime, no
  `q`/`n` shard configuration, no cluster concepts.
- **Built-in web UI** — preserves the Fauxton property from
  [ADR 0007](decisions/0007-couchdb-primary-store.md): the data is browsable and usable
  with no custom webui at all.
- **zlib + delta compression.** Not marginal. Fossil achieves **74:1** on SQLite's own
  repository (7.1 GB of artifacts → under 97 MB; median compressed blob 156 bytes against
  45,312 bytes uncompressed). [`bundles.md`](bundles.md) measures **106.7 MB of
  transcripts across 43 objects** — highly repetitive JSONL, exactly the shape delta
  compression eats.

### The four disqualifiers

**1. Concurrency — the fatal one.**

Fossil is documented as intended to be used *one operation at a time, in sequence, with
each user holding their own clone*. SQLite's database-level locking means a single writer
that blocks readers and other writers; the Fossil forums carry recurring
`database is locked` reports from exactly the pattern of a server and a client touching
one repository file.

The hook deliberately **spawns separate processes per event that race on the transcript
offset**. [`mid-flight-chunking.md`](mid-flight-chunking.md) already needs an `O_EXCL`
lockfile in `/tmp` to serialize them, and when the lock is held it *skips* the flush.
Layering Fossil's repository-wide write lock underneath turns a skipped flush into a
blocked one — and the hook's hard rule (`CLAUDE.md`, and the reason every external call is
wrapped in try/catch) is that **it never blocks a session**.

This would add a global mutex to the one path that must not have one.

**2. Document content is opaque.**

Artifacts are stored zlib-compressed and delta-encoded. Fossil's metadata tables are
explicitly *computed indices* — filenames, check-in lineage, tags, wiki pages, tickets,
cross-references — regenerable at any time via `fossil rebuild`. They index **VCS
concepts, not application documents**.

So the 18 map views over `entries[]` — `speaker_split/by_role`,
`speaker_split/by_role_time`, `chunks/entries_by_session`, `session_index/aggregate` —
have **no Fossil equivalent**. You cannot query inside a delta-compressed blob without
decompressing it. Every projection moves into an index you build and maintain yourself, at
which point you are running Fossil *plus* a query store, having deleted the query store.

**3. It re-triggers the exact objection that killed SQLite.**

[`database-choice.md`](database-choice.md) rejected SQLite/libSQL for losing the
HTTP-native proxy story and pushing logic into the webapi. Fossil's HTTP surface is a sync
protocol, an HTML web UI, and a partial JSON API — not a REST document API. The
`/api/couch` read-only proxy ([ADR 0016](decisions/0016-webapi-is-the-io-gateway.md))
stops being a thin honest passthrough and becomes re-implemented CRUD.

Same objection as SQLite, and Fossil answers it *worse* — SQLite at least offers a clean
embedded query API.

**4. Sync semantics are the wrong shape.**

Fossil converges *whole repositories*: every clone holds every artifact. There is no
filtered or selector-based replication (CouchDB has both), and conflicts resolve as VCS
forks and branches, not per-document. For "a team shares its Claude Code usage history"
([ADR 0007](decisions/0007-couchdb-primary-store.md)) you would want partial replication
almost immediately — per host, per project, per retention window.

**Plus a public-project cost.** `CLAUDE.md` requires assuming the reader knows nothing
about the deployment. "Install Fossil as your transcript database" is off-label use of a
tool built to host SQLite's own development: no client libraries for this purpose, no
operational literature, and no prior art to lean on.

### What the question is actually reaching for

The want underneath "Fossil" reads as: **SQLite's footprint plus real multi-master
replication.** That combination exists, and it is not Fossil:

- **cr-sqlite** — a SQLite extension adding CRDT semantics so independent replicas merge
  without a coordinator. This is the genuine peer to CouchDB's replication story in the
  single-file world, and the append-only document model here is already CRDT-friendly by
  construction. **This is the thing worth re-evaluating, not Fossil.**
- **libSQL / sqld embedded replicas** — replication, but leader–follower, not masterless.
  Solves distribution; does not solve multiplayer.
- **Litestream** — continuous streaming of a SQLite database to object storage. Garage is
  already deployed. Backup/DR rather than sync — but it may be all Tier 1 needs.

### And the use case may already be solved

[`bundles.md`](bundles.md) reports a **verified round-trip**: 7,135 documents / 43 blobs /
117 MB, a destroyed session restored with every detail field, token count and transcript
entry identical, and zero duplicate documents on re-import.

"Move history between machines" and "keep an off-instance backup" are **done**. Replication
is currently buying a Tier-3 capability that hasn't been built yet.

### Where Fossil could genuinely fit

As **bundle transport / archive format**. Its delta compression would compress that
106.7 MB hard, and its sync protocol would give incremental bundle transfer for free —
which would also fix the known inefficiency in [`bundles.md`](bundles.md) (import
re-uploads every blob even when the bytes are identical; 16 s for 102 MB on a redundant
restore).

Far smaller and more defensible than replacing the store. Though plain zstd over the
existing bundle format probably captures most of the win for none of the dependency.

---

## Part 3 — Service briefs

> Can you give me a brief on each of the services you mentioned, starting with EdgeDB?

### Gel (formerly EdgeDB)

> Not in the original list of alternatives — that list was ClickHouse, DuckDB+Parquet,
> Quickwit, VictoriaLogs/Loki, SQLite/libSQL and a log buffer, plus Qdrant/LanceDB and
> Meilisearch/Typesense which came from `database-choice.md`. Included because it was
> asked for.

Renamed from EdgeDB to **Gel** in February 2025. A graph-relational database with its own
query language (EdgeQL), a strict schema, built-in authentication, and vector/RAG
features — **implemented on top of PostgreSQL**, which it uses for both storage and query
execution. Gel 6.0 added full SQL support in both Postgres-protocol and native modes.

**Verdict: rules itself out twice.** It is PostgreSQL wearing a nicer coat, and
[`database-choice.md`](database-choice.md) explicitly excludes PostgreSQL. More
fundamentally, its entire value proposition is *strict schemas with typed links* — the
opposite of what [ADR 0007](decisions/0007-couchdb-primary-store.md) chose CouchDB for
("event docs of differing shapes coexist with no migrations"). Gel is a very good database
for an application with a modelled domain. This corpus is a heterogeneous append-only
event stream, the one shape it is worst at.

### The analytical slot

**ClickHouse** — Columnar, MergeTree engine (LSM-ish: inserts land as parts, merged in the
background). Ingest in the hundreds of MB/s; aggregations that take CouchDB map-reduce
minutes run in milliseconds. HTTP interface, `JSONEachRow` ingest, native JSON type. Wants
*batched* inserts — small frequent inserts trigger "too many parts". No document CRUD, no
masterless replication.
**Verdict:** the right answer if and when Tier-2 analytics hit the predicted ceiling — as
an *added* derived store, never as the source of truth.

**DuckDB + Parquet on Garage** — Embedded columnar engine, no server, reads Parquet
directly from S3. The object store is already deployed, so this adds **zero services**.
**Verdict:** the pick for Tier 1/2. Detailed in
[Part 5](#part-5--duckdb--parquet--garage-in-detail).

### The log / telemetry slot

> **Superseded by [Part 4](#part-4--application-logs--filesystem--garage).** These briefs
> are kept because the comparison is still useful, but the recommendation changed once
> Garage's lifecycle support was confirmed.

**VictoriaLogs** — Purpose-built log database from the VictoriaMetrics team. Very low
resource use, high ingest, native retention/TTL, LogsQL query language. Was the original
recommendation for the app-logs database; now second choice, because it costs a service
that filesystem-to-Garage doesn't.

**Loki** — Grafana's log store: indexes labels only, with log content chunked into object
storage. Structurally very close to what this project already built (S3 blobs + light
CouchDB metadata).
**Verdict:** interesting mainly as validation that the existing architecture is right. Not
worth adopting unless already in the Grafana ecosystem.

**Quickwit** — Search engine (tantivy-based) that writes indexes *to object storage* and
queries them there. Sub-second search over data in S3, decoupled compute and storage,
built for append-heavy log search.
**Verdict:** architecturally elegant given Garage, but Meilisearch holds this slot and does
typo-tolerant human search better. Revisit only if index size outgrows a single node.

### The buffer slot

**NATS JetStream** — Lightweight (single Go binary), persistent append-only streams,
subject-based routing, configurable retention.

**Redpanda** — Kafka-API-compatible, C++, no ZooKeeper or JVM, far lower footprint than
Kafka.

**Verdict for both:** the classic "optimize for write" answer — an append-only log absorbs
the burst, consumers materialize read models at their own pace. Both are over-engineering
for a single-user Tier-1 tool, and the JSONL transcript file already plays this role.
Worth remembering for Tier 3.

### The embedded slot

**libSQL / SQLite (WAL)** — Fork of SQLite adding a server mode (`sqld`), embedded
replicas, and extensions. In WAL mode, batched small writes run thousands per second —
comfortably faster than CouchDB's single-document PUTs. FTS5 provides decent lexical
search for free.
**Verdict:** rejected in [`database-choice.md`](database-choice.md) on architecture, not
performance, and that rejection holds. **But paired with cr-sqlite the replication
objection weakens considerably** — that is the combination worth re-evaluating.

**cr-sqlite** — CRDT extension for SQLite; replicas merge without a coordinator.
**Litestream** — continuous replication of a SQLite file to object storage (backup/DR, not
sync). Both discussed in [Part 2](#what-the-question-is-actually-reaching-for).

### The search / vector slots

Compared in detail in [Part 6](#part-6--the-vector-slot-compared): **Qdrant**, **LanceDB**,
and **Typesense** — which belongs to a different slot than the other two.

---

## Part 4 — Application logs: filesystem → Garage

> For logs, could we not just write to FS then rotate to a Garage bucket?

**Yes. Do this instead of VictoriaLogs.** This supersedes the recommendation in
[Part 3](#the-log--telemetry-slot).

The deciding fact is Garage's S3 compatibility surface: **Garage supports
`PutBucketLifecycleConfiguration` with `Expiration`** — by age or fixed date, with optional
prefix and object-size filters. That solves retention as bucket configuration rather than
code. Recall that the core complaint against CouchDB for logs was "no TTL, so expiry means
a delete sweep *plus* a compaction". Garage simply expires them. That settles the slot.

Everything else lines up:

- **It is the architecture already in use.** [ADR 0014](decisions/0014-transcripts-live-in-s3-only.md)
  does exactly this for transcripts: append locally, escrow to S3. This applies a proven
  pattern rather than inventing one.
- **`s3.buckets` is already a keyed map** — `config/config.template.json` has only
  `sessions`, and `CLAUDE.md` states it is "designed for **more than one** bucket". Adding
  `logs` is configuration, not architecture.
- **No new dependency.** `packages/webapi/src/storage/s3-blob-store.ts` already uses Bun's
  built-in `S3Client`, vendor-neutral against Garage/MinIO/R2/AWS.
- **Fastest possible write path** — a local append cannot block a session, satisfying the
  hook's hard invariant for free.
- **Reads unify with the analytical slot.** DuckDB reads NDJSON or Parquet straight from
  the bucket. One query mechanism, two uses.

For a public FOSS project this also *removes* a service users must run rather than swapping
one for another — worth more than the technical merits alone, given `CLAUDE.md`'s "don't
assume our own topology".

### What has to be handled

**Live tail is the real loss.** [ADR 0018](decisions/0018-app-logging-into-couchdb.md)'s
stated benefit was "one place to inspect cross-component failures". A rotated log is
invisible until it rotates. Mitigations: keep stderr for live (that ADR already mandates
the fallback), and add `claude-transcripts logs --tail` reading local files. At Tier 1 —
single user, single machine, no on-call — this costs almost nothing. It would be
disqualifying at Tier 3.

**The host/container split is the awkward part.** The hook runs on the host; the webapi
runs in a container. Different filesystems, so "write to FS" means two different
filesystems. Cleanest resolution: **each writer rotates to Garage independently.** The hook
already writes to S3 directly and already holds credentials —
[ADR 0016](decisions/0016-webapi-is-the-io-gateway.md)'s amendment explicitly blesses it as
a second writer for exactly this reason. Routing logs through the webapi would reintroduce
the dependency this is trying to delete.

**Never let two processes append to one object.** Key on component + host + time:

```
logs/component=hook/host=<hostname>/dt=2026-08-28/<pid>-<epoch>.ndjson.zst
logs/component=webapi/host=<hostname>/dt=2026-08-28/<pid>-<epoch>.ndjson.zst
```

Hive-style `key=value` segments so DuckDB's `hive_partitioning=1` picks them up as columns
for free, and prefix-based lifecycle rules can expire components at different rates.

**Small-file problem.** Rotate too eagerly and you get thousands of tiny objects — Garage
metadata pressure and slow scans. Rotate on **size-or-age, whichever first** (say 8 MB or
1 hour), mirroring the chunk flusher's 200-entries-or-15s policy at
`config/config.template.json:7`. A daily roll-up then compacts yesterday's fragments into
one Parquet file.

**Crash loses the un-rotated tail** — the same trade transcripts already accept. Acceptable
for operational logs.

### Suggested configuration shape

```jsonc
"s3": { "buckets": { "sessions": "...", "logs": "claude-transcripts-logs" } },
"logging": {
  "app": {
    "dir": "~/.claude-transcripts/logs",
    "rotate": { "maxBytes": 8388608, "maxAgeMs": 3600000 },
    "retentionDays": 30   // applied as a Garage lifecycle rule at setup time
  }
}
```

`claude-transcripts setup` puts the lifecycle rule on the bucket. Retention becomes
declarative and Garage enforces it, with no sweeper to write.

**Net effect: [ADR 0018](decisions/0018-app-logging-into-couchdb.md) gets superseded, not
amended.** Its promise changes from "centralised live aggregation in CouchDB" to "durable
archive in object storage, queryable after the fact, live via stderr" — a smaller system
that does the actual job.

---

## Part 5 — DuckDB + Parquet + Garage, in detail

> And more details of DuckDB + Parquet + Garage.

### The pipeline

```
CouchDB _changes  ──►  follower (batch)  ──►  Parquet  ──►  Garage
                                                              │
                              webapi ──► DuckDB (httpfs) ◄────┘
```

The follower pattern already exists — `packages/webapi/src/storage/search-follower.ts`
feeds Meilisearch off `_changes`. A Parquet materializer is the same shape with a
different sink, which is the main reason this is cheap for this repo specifically.

### Connecting DuckDB to Garage

The critical detail is path-style addressing — Garage requires it, and
`s3-blob-store.ts` already notes this in its header comment:

```sql
INSTALL httpfs; LOAD httpfs;
CREATE SECRET garage (
  TYPE s3,
  KEY_ID '...', SECRET '...',
  ENDPOINT 'localhost:7663',
  URL_STYLE 'path',        -- required for Garage/MinIO
  USE_SSL false
);
```

### Layout

```
analytics/turns/dt=2026-08-28/part-0.parquet
analytics/events/dt=2026-08-28/part-0.parquet
analytics/sessions/dt=2026-08-28/part-0.parquet
```

Three tables, flattened from the existing document types: `sessions` (one row per summary),
`events` (one row per event doc), `turns` (one row per entry in `entries[]` — the grain
that makes `speaker_split` redundant).

```sql
SELECT role, count(*), sum(tokens)
FROM read_parquet('s3://…/analytics/turns/**/*.parquet', hive_partitioning=1)
WHERE dt >= '2026-08-01' GROUP BY role;
```

Predicate pushdown on `dt` means only relevant files are fetched; column pruning means only
referenced columns are read. That is the whole advantage over map-reduce views in one
sentence.

### File sizing — and an honest caveat

The usual advice is 100–500 MB per Parquet file. **The entire live corpus here is 9.7 MB.**
So: one file per day, compacted monthly, and no elaborate partitioning. More bluntly —
**at current scale DuckDB is overkill and CouchDB views are fine.** This becomes the right
call when one of these trips:

- The corpus grows 10–100× (content chunks under
  [ADR 0027](decisions/0027-full-content-chunks-in-couchdb.md) will push this).
- A query worth having takes more than a couple of seconds through a view.
- A 9th design doc is wanted — that is the signal to build the derived store instead.

Building it before then is premature infrastructure.

### Runtime wrinkle

The official client is `@duckdb/node-api`, a native N-API addon. Bun implements roughly 95%
of Node-API and napi-rs modules generally work, but **verify with a spike before
committing** — this is the kind of thing that is fine until it isn't. DuckDB-Wasm is a
fallback, and could even run in the webui, though querying Garage from the browser would
need to go through the existing `/api/s3` proxy to stay inside
[ADR 0016](decisions/0016-webapi-is-the-io-gateway.md).

---

## Part 6 — The vector slot, compared

> I would like a comparative analysis of the vector slot.

### First, a framing correction

**Typesense does not belong in this comparison.** It and Meilisearch are *lexical-first*
engines with hybrid search added; Qdrant and LanceDB are *vector-first* stores. Treating
all three as "the vector slot" conflates two jobs:

| Job | Who asks | Query | Candidates |
|---|---|---|---|
| **Human lexical search** | A person, in the webui | "that session about Garage" | Meilisearch, Typesense |
| **Agent semantic retrieval** | Claude Code, Tier 2 | "prior work resembling this task" | Qdrant, LanceDB |

[`database-choice.md`](database-choice.md) already reaches this conclusion — it keeps
Meilisearch for lexical and *adds* vectors for agent recall. Typesense is a lateral move
within the first row; it does not compete in the second. As a near drop-in for Meilisearch
with comparable hybrid search and faceting and slightly better high-cardinality filtering,
it is a coin-flip — not worth a migration absent a specific complaint.

### Qdrant vs LanceDB

| | **Qdrant** | **LanceDB** |
|---|---|---|
| **Shape** | Server (Rust); REST + gRPC | Embedded library; no process |
| **Storage** | Own on-disk format, memory-mapped | Lance columnar files, natively on object storage |
| **Index** | HNSW, on-disk capable | IVF-PQ and HNSW |
| **Filtering** | **Filterable HNSW** — payload indexes consulted *during* graph traversal | Pre/post-filter around the search |
| **Quantization** | Scalar, product, **binary** — large memory savings | Product quantization via IVF-PQ |
| **Backup** | Snapshot API — a second backup mechanism to own | **Just files in Garage** — existing bundles cover it free |
| **TS/Bun** | HTTP client, pure JS — no native module risk | napi-rs native addon — should work on Bun, verify |
| **Ops cost** | One more container, one more port in 7650–7661 | Zero services |
| **Latency over S3** | N/A (local disk) | Higher — network round trips per index probe |

**Qdrant's genuine differentiator is filtered vector search.** Naive systems either
pre-filter (the HNSW graph may be disconnected and recall collapses) or post-filter (fetch
10× and discard, wasting work). Qdrant consults payload indexes during traversal, staying
correct and fast. If Tier-2 queries look like *"semantically similar, but only my sessions,
only this repo, only last quarter"* — and given every doc carries `hostname` and `cwd`,
they will — that is not a minor feature.

**LanceDB's genuine differentiator is substrate unification.** Lance is a columnar format
like Parquet, but designed for **random access**, which is precisely why Parquet cannot
back a vector index and Lance can. So LanceDB and DuckDB-over-Parquet are not two decisions
— they are **one object store, two formats, zero services**, both landing in Garage, both
covered by the existing bundle mechanism. That coherence carries real weight for a project
whose stated posture is minimal footprint.

### Verdict

[`database-choice.md`](database-choice.md)'s call holds, and the DuckDB analysis
strengthens it: **LanceDB for Tier 2, Qdrant if a single process is outgrown** — where
"outgrown" concretely means multi-user (Tier 3), concurrent writers, filtered search over
millions of vectors, or wanting the index to survive independently of the app process.

Two caveats that matter more than the store choice:

**At current scale, both are overkill.** ~43 sessions is perhaps a few thousand chunks.
Brute-force cosine similarity over a few thousand vectors in-process is under 10 ms — no
index, no dependency. A vector *store* earns its keep at 10⁵–10⁶ vectors. Start with a flat
scan; the point where it stops being enough will be obvious.

**The hard part is embeddings, not storage.** A model, a chunking strategy, and a
re-embedding path when the model changes. Local (fastembed/ONNX) keeps the
no-external-dependency story; an API is better quality but breaks self-hosted-offline. That
decision is independent of Qdrant-vs-LanceDB, it is harder, and it is the one worth
thinking about first.

---

## Summary

| Slot | Today | Recommendation |
|---|---|---|
| Source of truth (transcripts) | S3 / Garage blobs | **Keep.** Already the write-optimized path. |
| Metadata + projections | CouchDB | **Keep.** Run compaction; batch with `_bulk_docs`. |
| Application/operational logs | CouchDB (separate DB) | **Move to filesystem → Garage** with a lifecycle rule ([Part 4](#part-4--application-logs--filesystem--garage)). VictoriaLogs second choice. |
| Analytics | CouchDB map-reduce | **Add** DuckDB+Parquet when it bites; ClickHouse at scale. |
| Lexical search | Meilisearch | **Keep.** Typesense a coin-flip, not worth migrating. |
| Vector search | — | **Add** LanceDB for Tier 2; start with a brute-force scan. |
| Replication | CouchDB native (unused) | Bundles already cover the real need. Re-evaluate cr-sqlite before Fossil. |

**Bottom line:** keep CouchDB as the source of truth. Run compaction. Move the app-logs
database to filesystem-plus-Garage — that is the swap actually worth making, it deletes a
dependency rather than swapping one, and
[ADR 0018](decisions/0018-app-logging-into-couchdb.md) already blessed the abstraction as
swappable. Add DuckDB-over-Parquet when analytics bite. Fossil is a beautiful piece of
engineering aimed at a different problem.

---

## Evidence

Claims above are anchored to these, so they can be re-checked:

| Claim | Source |
|---|---|
| Single-document writes, no `_bulk_docs` | `packages/cli/src/hook/runtime.ts:78`, `:90` |
| 8 design docs / 18 JS map views | `packages/shared/src/migrations/designs.ts`, `session-index.ts`, `speaker-split.ts` |
| Chunk flush batching (200 entries / 15000 ms) | `config/config.template.json:7` |
| Concurrent hook processes, `/tmp` lockfile, flush skipped on contention | [`mid-flight-chunking.md`](mid-flight-chunking.md) |
| 9.7 MB live in a 92.7 MB file, 7,090 docs; 106.7 MB blobs / 43 objects | [`bundles.md`](bundles.md) |
| Verified bundle round-trip, 7,135 docs / 117 MB | [`bundles.md`](bundles.md) |
| `_changes` follower pattern already in use | `packages/webapi/src/storage/search-follower.ts` |
| Bun `S3Client`, path-style addressing for Garage | `packages/webapi/src/storage/s3-blob-store.ts` |
| `s3.buckets` is a keyed map designed for more than one bucket | `config/config.template.json`, `CLAUDE.md` |
| Hook must never block a session | `CLAUDE.md`, key invariants |
| S3 is the transcript's sole home | [ADR 0014](decisions/0014-transcripts-live-in-s3-only.md) |
| Content chunks are a projection, not a second authority | [ADR 0027](decisions/0027-full-content-chunks-in-couchdb.md) |
| App-log store is swappable behind the webapi | [ADR 0018](decisions/0018-app-logging-into-couchdb.md) |
| Hook is a blessed second writer, direct to CouchDB and S3 | [ADR 0016](decisions/0016-webapi-is-the-io-gateway.md) |
| No MongoDB / Elasticsearch / PostgreSQL; ClickHouse named as scale ceiling | [`database-choice.md`](database-choice.md) |

## External sources

- [Fossil — technical overview](https://fossil-scm.org/home/doc/trunk/www/tech_overview.wiki)
  — artifact storage, zlib + delta compression, 74:1 ratio, metadata tables as regenerable
  computed indices.
- [Fossil user forum — "database is locked"](https://fossil-scm.org/forum/forumpost/a1ddfe088c)
  — one operation at a time, each user their own clone.
- [Garage — S3 compatibility status](https://garagehq.deuxfleurs.fr/documentation/reference-manual/s3-compatibility/)
  — lifecycle `Expiration` by age or date, with prefix and size filters.
- [Bun — Node-API support](https://bun.com/docs/runtime/node-api) — native addon
  compatibility for the DuckDB and LanceDB clients.
- [LanceDB architecture](https://deepwiki.com/lancedb/lancedb) — napi-rs Node binding.
- [EdgeDB is now Gel, and Postgres is the Future](https://www.geldata.com/blog/edgedb-is-now-gel-and-postgres-is-the-future)
  — the February 2025 rename and the PostgreSQL backend.
- [EdgeDB Rebrands as Gel, Brings Full SQL Support](https://linuxiac.com/edgedb-rebrands-as-gel-brings-full-sql-support/)
  — Gel 6.0 SQL support.

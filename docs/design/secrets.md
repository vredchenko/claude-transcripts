# Leaked secrets: detection and scrubbing

Status: **future scope, not designed in detail.** This page collects the problem, the
constraints and the shape of a solution so the design work starts from one place. It
replaces the bare `features.secretsMasking` flag (present in
[`config/config.template.json`](../../config/config.template.json), with no
implementation) as the roadmap item ([roadmap.md](roadmap.md#tier-1-known-gaps)).
It still gates recall scopes wider than `project` ([plugin.md](plugin.md#privacy)) and
sharing bundles.

## The problem

A session records everything that passes through it. When a tool call prints a
credential (`cat` of a config file, `env`, a debug log, a pasted connection string),
that secret ends up in the transcript and is copied into every store behind the
webapi:

- CouchDB `event`, `chunk` and `summary` documents, **including old revisions** until
  compaction, and the deleted-document markers it keeps afterwards;
- S3 objects (`transcript.jsonl`, `summary.json`) and any object versions;
- Meilisearch indexes (live and archive turn indexes), where it is also *searchable*;
- every [mirror](../operate/mirrors.md) the write fanned out to;
- exported bundles and backups taken since;
- and on the client, the Claude Code transcript under `~/.claude/projects/`, which is
  the source `backfill` and `repair` read from. Scrubbing the backend alone means the
  next backfill brings the secret back.

Scrubbing does not make a leaked secret safe again. Rotation does. The most valuable
output of detection is telling the user, promptly and clearly, that a credential needs
rotating. Removing it from history limits further exposure (search, recall, export,
sharing) but never replaces rotation.

## Prerequisite: one write path

Write-time detection only works if every write passes through the same checkpoint. Today
the hook writes to CouchDB and S3 directly and bypasses the webapi (#288). Until it
writes through `/api/ingest/*` like every other writer, any write-time guard misses the
main source of data. This feature depends on #288.

## Layers of defence

Each layer catches what the previous one missed. None is enough alone.

### 1. In-session: Claude notices

Claude often spots a credential in tool output as it reads it. Today it can only warn
in chat. The plugin should turn that moment into an action:

- **Plugin instructions:** when Claude sees a credential in tool output or its own
  reply, it says so, names the kind of secret (not the value), and offers to scrub.
- **Slash command:** `/claude-transcripts:leaked-secrets scan` (this session, or a
  given scope) and `/claude-transcripts:leaked-secrets scrub`, for when the user
  explicitly asks or confirms after a warning.
- **CLI:** `claude-transcripts secrets scan|scrub` with session, project and time-range
  scopes, for use outside a session and from scripts. The CLI goes through webapi
  endpoints like every other client (ADR 0016). It also handles the client-side copy
  under `~/.claude/projects/`, which only the client can reach.

### 2. Deterministic scanners

Pattern- and entropy-based detection that doesn't depend on Claude noticing. Candidates
to evaluate: **gitleaks**, **trufflehog** (it can also verify whether a credential is
live, which helps decide priority), **detect-secrets** (baseline/allowlist model), and
**trivy**'s secret scanner (already in the release scan gate). **grype** is
vulnerability-only and does not detect secrets, so it is not a candidate here.
Evaluation criteria: rule coverage, false-positive rate on transcript-shaped data,
throughput over a large corpus, licence, and whether it can run as a library or must be
spawned.

### 3. Backend triggers

Deterministic scans run by the backend, not the client:

- **At write time,** on `/api/ingest/*`: detect and either flag or redact before the
  document is stored. This only covers all writes once #288 lands.
- **When a session ends:** a full scan of the finished session.
- **On a schedule:** sweeps over the whole corpus, so new rules and updated scanners
  catch old leaks. This needs the scheduled-task runner listed under
  [Tier 3](roadmap.md#tier-3-multiplayer-and-public-release).
- **Bulk paths:** `import`, `backfill`, `repair` and bundle export run the same checks.
  Import and backfill must not reintroduce a secret that has been scrubbed. Export must
  not ship one.

### 4. On read: the last line of defence

To consider: mask secrets in the responses of search and read endpoints
(`/api/search`, `/api/sessions/*`, `/api/turns`, the read-only `/api/couch/*` and
`/api/s3/*` proxies, and recall). This catches what slipped past writes, the user's
attention and the scheduled scrub. Open questions: cost per request, whether masking
on read conflicts with the read-only proxies' "native API as-is" promise (ADR 0016),
and whether a privileged unmasked read is needed for scrubbing itself.

## What a scrub has to cover

- **CouchDB:** rewrite affected documents with the value replaced by a redaction
  marker, then compact so old revisions are removed. Fully removing a document needs
  `_purge`, because deleted documents otherwise leave markers behind and replicate.
  This is a sanctioned exception to the "append-only / immutable docs" rule and needs
  an ADR.
- **S3:** rewrite the object. Delete old versions if versioning is enabled.
- **Meilisearch:** reindex the affected documents. Meilisearch's own snapshots and dumps
  need checking too.
- **Mirrors and bundles:** a scrub on one instance should be able to propagate to its
  mirrors. Bundles already exported can only be listed and the user warned.
- **Client copy:** an optional, explicit scrub of the local transcript file. Without it,
  a backfill will re-import the secret unless the backfill path re-checks (layer 3).
- **Audit trail:** every scrub is recorded (what kind of secret, where, when, by which
  trigger) **without the secret value**, e.g. a hash prefix to identify it.

Redaction format to decide: something like `[REDACTED:<rule>:<hash8>]`. It keeps the
transcript readable, shows that something was removed, and lets the same secret be
recognised across documents without storing it.

## False positives, exceptions and user decisions

Transcripts are full of things that look like secrets: hashes, UUIDs, base64 blobs,
example keys in docs, test fixtures, tool-call payloads. Without memory of what the user
already decided, the feature becomes noise.

- **Recorded decisions:** "not a secret", "accepted risk", "already rotated". They are
  stored against a fingerprint (hash) of the value, never the value, and scoped to
  instance, project or session.
- **Never ask twice** about the same fingerprint at the same scope.
- **Where findings and decisions live:** candidates are a dedicated CouchDB database
  and/or Fossil tickets. [ADR 0031](decisions/0031-fossil-as-bundled-infrastructure.md)
  bundles Fossil as backstage infrastructure, and its ticket tracker suits an admin
  queue of findings with their history and decisions.

## Configuration

This adds a fair amount of application config. A first cut of the knobs:

- enable/disable per layer (in-session, write-time, session-end, scheduled, read-time);
- action per layer: detect only, ask, or redact automatically;
- scanners enabled, rule sets, severity and entropy thresholds;
- schedule for sweeps;
- scope rules (include/exclude by project path, mirroring recall's `excludeCwdGlobs`);
- where findings and decisions are recorded;
- whether scrubs propagate to mirrors.

Defaults to decide. A reasonable starting point: detect and warn everywhere, redact
automatically nowhere, and read-time masking on for recall scopes wider than `project`.

## Testing

- a corpus of synthetic secrets (never real ones) in transcript-shaped data,
  including inside tool-call inputs and outputs, JSON-escaped strings and base64;
- tests that a scrub leaves no copy anywhere: CouchDB current and old revisions, S3
  objects and versions, Meilisearch, and the read endpoints;
- tests that `backfill`, `import` and `repair` don't bring back a scrubbed secret;
- tests that recorded exceptions suppress repeat prompts;
- false-positive benchmarks against a real-shaped corpus.

## Open questions

- Redact at write time, or store and flag? Redacting at write time loses information
  if it was a false positive.
- Does read-time masking replace write-time redaction for some deployments, or always
  add to it?
- How should a scrub on one instance reach replicated instances (Tier 3 replication)?
- Should scanners run in the webapi process, as a sidecar, or in the scheduled-task
  runner?
- Can in-session detection hand Claude's finding to the backend without the secret
  itself crossing another boundary (e.g. send the location and a hash, not the value)?

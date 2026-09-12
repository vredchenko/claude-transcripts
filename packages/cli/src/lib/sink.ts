/**
 * Where ingested docs/blobs are delivered.
 *
 * Per ADR 0016 the webapi is the I/O gateway for this path: `backfill` never writes CouchDB/S3
 * directly. Host-side ingestion reads local files the container can't see and hands
 * the derived docs **to** the webapi (an input source, not a backend write around
 * it — docs/reference/cli.md). `--dry-run` swaps in a sink that only prints.
 *
 * `WebapiSink` calls the **generated** API client (../api/generated, from the
 * OpenAPI spec — ADR 0019) for the JSON endpoints; the transcript blob and the
 * existence check use the transport helpers in ../api/http (raw body / 404-safe
 * GET have no place in the typed JSON client). The `SessionSink` interface keeps
 * the destination swappable — e.g. a future direct-backend `HostSink`.
 */
import { ingestChunks, ingestEvents, ingestSummary, resetSession } from "../api/generated";
import { exists, getOrNull, putRaw, setWebapiUrl, webapiUrl } from "../api/http";
import type { ChunkDoc, EventDoc, SummaryDoc } from "./session-docs";

/** What a reset removed, for reporting. */
export interface ResetCounts {
  summary: number;
  events: number;
  chunks: number;
}

/**
 * What is already stored for a session, as far as re-ingestion needs to care.
 *
 * `source` is the load-bearing field: a `live` record was written by the hook as the
 * session happened and carries provenance no reconstruction can recover, while a
 * `backfill` record was itself reconstructed and is safe to rebuild.
 */
export interface ExistingSession {
  source: string;
  /** `running` while a session is still live; repair must not touch those. */
  status?: string;
}

export interface SessionSink {
  /**
   * The stored record for this session, or null if there is none.
   *
   * Replaces a bare "already ingested?" boolean: idempotency only needs yes/no, but
   * deciding whether a re-ingest would *downgrade* the record needs to know what the
   * record is.
   */
  existingSession(sessionId: string): Promise<ExistingSession | null>;
  /**
   * Does this session have readable turn content?
   *
   * Turns come only from full-content `chunk` docs, so this answers the question
   * `--repair` exists for — "is anything searchable here?" — without needing a chunk
   * count the read API doesn't expose.
   */
  hasTurns(sessionId: string): Promise<boolean>;
  /**
   * Is the byte-exact transcript actually in the blob store?
   *
   * Deliberately not `hasTranscript` off the read API: that is true when *either* the
   * chunks or the blob exist, so it cannot see the state this asks about — chunks
   * present, blob gone. S3 is the transcript's only verbatim home (ADR 0014); chunks
   * are the pruned projection (ADR 0027), which is why a session missing its blob still
   * reads perfectly through the API and looks healthy.
   */
  hasTranscriptBlob(sessionId: string): Promise<boolean>;
  /**
   * Drop a session's derived docs so it can be ingested again.
   *
   * Needed because re-ingesting over the top doesn't replace: events would duplicate
   * (CouchDB-assigned ids) and chunks are keyed by byte offset, so re-chunking leaves
   * the old ones behind. The S3 transcript is untouched — re-ingest overwrites it.
   */
  resetSession(sessionId: string): Promise<ResetCounts>;
  putSummary(doc: SummaryDoc): Promise<void>;
  putEvents(docs: EventDoc[]): Promise<void>;
  putChunks(docs: ChunkDoc[]): Promise<void>;
  putTranscript(sessionId: string, bytes: Uint8Array): Promise<void>;
  /** human label for logs (e.g. the webapi URL, or "dry-run") */
  readonly label: string;
}

/**
 * Prints what it *would* do. The `--dry-run` sink.
 *
 * **Read-only, not offline.** It stubs every write and delegates every *read* to a real
 * sink, because what a backfill does to a session turns entirely on what is already
 * stored — `already-adopted`, `live-record`, `running`, `has-turns`, `repair`,
 * `repair-blob`. Answering those from nothing collapsed the whole decision tree onto its
 * one remaining leaf: every session previewed as a fresh adoption, so a preview over a
 * corpus of 542 sessions announced 16 adoptions where a real run would have skipped 15
 * of them. Worst on `--repair`, which exists to act on records that already exist and
 * therefore previewed the destructive-shaped operation it was added to avoid.
 *
 * The reads are GETs. Consulting them writes nothing, which is the only promise
 * `--dry-run` makes.
 */
export class DryRunSink implements SessionSink {
  readonly label = "dry-run";
  /**
   * True once a read failed. A preview that could not reach the store must say so:
   * silently answering "nothing is stored" is the old bug, made permanent.
   */
  blind = false;
  private reader: SessionSink | null | undefined;

  constructor(reader?: SessionSink) {
    this.reader = reader;
  }

  /** The read sink, built on first use so an unreachable instance can't break construction. */
  private reads(): SessionSink | null {
    if (this.reader === undefined) {
      try {
        this.reader = new WebapiSink();
      } catch {
        this.reader = null;
        this.blind = true;
      }
    }
    return this.reader;
  }

  /** Run a read, and remember if the store could not answer. A 404 is an answer. */
  private async ask<T>(run: (r: SessionSink) => Promise<T>, whenBlind: T): Promise<T> {
    const r = this.reads();
    if (!r) return whenBlind;
    try {
      return await run(r);
    } catch {
      this.blind = true;
      return whenBlind;
    }
  }

  async existingSession(sessionId: string): Promise<ExistingSession | null> {
    return this.ask((r) => r.existingSession(sessionId), null);
  }
  async hasTranscriptBlob(sessionId: string): Promise<boolean> {
    // Blind, claim the blob is there: a preview must not talk anyone into a repair it
    // could not confirm was needed.
    return this.ask((r) => r.hasTranscriptBlob(sessionId), true);
  }
  async hasTurns(sessionId: string): Promise<boolean> {
    return this.ask((r) => r.hasTurns(sessionId), false);
  }
  async resetSession(sessionId: string): Promise<ResetCounts> {
    console.log(`  [dry-run] DELETE ${sessionId}  (summary + event + chunk docs)`);
    return { summary: 0, events: 0, chunks: 0 };
  }
  async putSummary(doc: SummaryDoc): Promise<void> {
    const tools = Object.keys(doc.tool_counts).length;
    console.log(
      `  [dry-run] PUT ${doc._id}  (${doc.token_usage.total} tok, ${doc.prompt_count} prompts, ${tools} tools)`,
    );
  }
  async putEvents(docs: EventDoc[]): Promise<void> {
    if (docs.length) console.log(`  [dry-run] PUT ${docs.length} event doc(s)`);
  }
  async putChunks(docs: ChunkDoc[]): Promise<void> {
    if (docs.length) console.log(`  [dry-run] PUT ${docs.length} chunk doc(s)`);
  }
  async putTranscript(sessionId: string, bytes: Uint8Array): Promise<void> {
    console.log(`  [dry-run] UPLOAD ${sessionId}/transcript.jsonl  (${bytes.byteLength} B)`);
  }
}

/**
 * Delivers to the webapi's curated ingest routes
 * (packages/webapi/src/routes/ingest.ts) via the generated client + transport.
 * Requires a reachable webapi with the `sessions` DB + bucket provisioned (the
 * webapi never creates buckets — see the Garage bootstrap in deploy/README.md).
 */
export class WebapiSink implements SessionSink {
  readonly label = webapiUrl();
  async existingSession(sessionId: string): Promise<ExistingSession | null> {
    return getOrNull<ExistingSession>(`/api/sessions/${encodeURIComponent(sessionId)}`);
  }
  async hasTurns(sessionId: string): Promise<boolean> {
    const res = await getOrNull<{ turns?: unknown[] }>(
      `/api/sessions/${encodeURIComponent(sessionId)}/turns?limit=1`,
    );
    return (res?.turns?.length ?? 0) > 0;
  }
  /**
   * Through the read-only S3 proxy, addressed by the **logical** bucket key — the
   * gateway maps `sessions` onto whatever the deployment named the bucket, so this
   * asks the same question on every instance rather than guessing a bucket name.
   */
  async hasTranscriptBlob(sessionId: string): Promise<boolean> {
    return exists(`/api/s3/sessions/${encodeURIComponent(sessionId)}/transcript.jsonl`);
  }
  async resetSession(sessionId: string): Promise<ResetCounts> {
    const res = await resetSession(sessionId);
    return res.deleted;
  }
  async putSummary(doc: SummaryDoc): Promise<void> {
    await ingestSummary(doc);
  }
  async putEvents(docs: EventDoc[]): Promise<void> {
    if (docs.length) await ingestEvents({ docs });
  }
  async putChunks(docs: ChunkDoc[]): Promise<void> {
    if (docs.length) await ingestChunks({ docs });
  }
  async putTranscript(sessionId: string, bytes: Uint8Array): Promise<void> {
    await putRaw(
      `/api/ingest/${encodeURIComponent(sessionId)}/transcript`,
      bytes,
      "application/x-ndjson",
    );
  }
}

export function makeSink(opts: { dryRun: boolean; webapiUrl?: string }): SessionSink {
  // Set before either branch: a dry run reads from the same instance a real run would
  // write to, so `--dry-run --webapi <url>` previews against that one rather than
  // quietly against the default.
  if (opts.webapiUrl) setWebapiUrl(opts.webapiUrl);
  return opts.dryRun ? new DryRunSink() : new WebapiSink();
}

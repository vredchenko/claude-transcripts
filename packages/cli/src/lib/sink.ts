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
import { getOrNull, putRaw, setWebapiUrl, webapiUrl } from "../api/http";
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

/** Prints what it *would* do; never touches a backend. The `--dry-run` sink. */
export class DryRunSink implements SessionSink {
  readonly label = "dry-run";
  async existingSession(): Promise<ExistingSession | null> {
    return null;
  }
  async hasTurns(): Promise<boolean> {
    return false;
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
  if (opts.dryRun) return new DryRunSink();
  if (opts.webapiUrl) setWebapiUrl(opts.webapiUrl);
  return new WebapiSink();
}

/**
 * Where ingested docs/blobs are delivered.
 *
 * Per ADR 0016 the webapi is the sole I/O gateway: the CLI never writes CouchDB/S3
 * directly. Host-side ingestion reads local files the container can't see and hands
 * the derived docs **to** the webapi (an input source, not a backend write around
 * it — docs/cli.md). `--dry-run` swaps in a sink that only prints.
 *
 * `WebapiSink` calls the **generated** API client (../api/generated, from the
 * OpenAPI spec — ADR 0019) for the JSON endpoints; the transcript blob and the
 * existence check use the transport helpers in ../api/http (raw body / 404-safe
 * GET have no place in the typed JSON client). The `SessionSink` interface keeps
 * the destination swappable — e.g. a future direct-backend `HostSink`.
 */
import { ingestChunks, ingestEvents, ingestSummary } from "../api/generated";
import { exists, putRaw, setWebapiUrl, webapiUrl } from "../api/http";
import type { ChunkDoc, EventDoc, SummaryDoc } from "./session-docs";

export interface SessionSink {
  /** Already ingested? (idempotency — skip work already done.) */
  hasSummary(sessionId: string): Promise<boolean>;
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
  async hasSummary(): Promise<boolean> {
    return false;
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
  async hasSummary(sessionId: string): Promise<boolean> {
    return exists(`/api/sessions/${encodeURIComponent(sessionId)}`);
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

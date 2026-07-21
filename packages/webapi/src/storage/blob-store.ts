export interface BlobStat {
  size: number;
  contentType?: string;
  etag?: string;
}

/**
 * Blob access. Reads are open; **writes are limited to objects** via the curated
 * ingest endpoints (ADR 0014/0016) — the store never creates buckets.
 */
export interface BlobStore {
  get(bucket: string, key: string): Promise<ReadableStream<Uint8Array>>;
  stat(bucket: string, key: string): Promise<BlobStat | null>;
  /** Write/overwrite a single object (curated ingest only). */
  put(bucket: string, key: string, body: Uint8Array | string, contentType?: string): Promise<void>;
}

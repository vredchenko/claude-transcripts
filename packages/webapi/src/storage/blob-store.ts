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
  /**
   * Delete an object. Absent is success — callers are cleaning up, and "it was
   * already gone" is the outcome they wanted.
   *
   * Only reachable through the session reset endpoint, and only when explicitly asked
   * for: the transcript blob is the one piece of a session that isn't derived, so
   * nothing removes it by default.
   */
  remove(bucket: string, key: string): Promise<void>;
}

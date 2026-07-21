import { S3Client } from "bun";
import type { Config } from "../config";
import type { BlobStat, BlobStore } from "./blob-store";

/**
 * S3-compatible blob store via Bun's built-in S3 client. Vendor-neutral: the same
 * code runs against Garage / MinIO / R2 / AWS by changing endpoint + keys
 * (path-style addressing, required by Garage/MinIO). Read-only here — the webapi
 * never creates buckets. Object writes are exposed only for curated ingest.
 */
export class S3BlobStore implements BlobStore {
  private readonly client: S3Client;

  constructor(config: Config) {
    this.client = new S3Client({
      endpoint: config.s3.endpoint,
      region: config.s3.region,
      accessKeyId: config.s3.accessKey,
      secretAccessKey: config.s3.secretKey,
    });
  }

  async get(bucket: string, key: string): Promise<ReadableStream<Uint8Array>> {
    return this.client.file(key, { bucket }).stream();
  }

  async stat(bucket: string, key: string): Promise<BlobStat | null> {
    const file = this.client.file(key, { bucket });
    if (!(await file.exists())) return null;
    const stat = await file.stat();
    return { size: stat.size, contentType: stat.type, etag: stat.etag };
  }

  async put(
    bucket: string,
    key: string,
    body: Uint8Array | string,
    contentType?: string,
  ): Promise<void> {
    await this.client
      .file(key, { bucket })
      .write(body, contentType ? { type: contentType } : undefined);
  }
}

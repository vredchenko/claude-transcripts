/**
 * S3-compatible blob client for the hook, via Bun's built-in S3 client. Disabled
 * (no-op) when no access key is configured. Buckets are addressed by name.
 */
import { S3Client } from "bun";
import type { HookConfig } from "./config";

export interface BlobClient {
  /** True when an S3 backend is configured (an access key is present). */
  enabled: boolean;
  /** Write an object; no-op + non-fatal when disabled or on error. */
  put(bucket: string, key: string, data: Buffer | string, contentType: string): Promise<void>;
}

export function makeBlob(config: HookConfig): BlobClient {
  const cfg = config.blob;
  const s3 = cfg?.accessKey
    ? new S3Client({
        endpoint: cfg.endpoint,
        region: cfg.region,
        accessKeyId: cfg.accessKey,
        secretAccessKey: cfg.secretKey,
      })
    : null;

  return {
    enabled: !!s3,
    async put(bucket, key, data, contentType) {
      if (!s3) return;
      try {
        await s3.write(key, data, { bucket, type: contentType });
      } catch {
        // non-fatal
      }
    },
  };
}

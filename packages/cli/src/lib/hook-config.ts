/**
 * Project the hook's runtime config from the app config + the instance env.
 *
 * This is the one file the hook itself reads, and nothing else writes it. It exists
 * because the hook runs as a separate short-lived process with no access to the
 * instance layout logic — so everything it needs (store URLs, credentials, feature
 * flags, chunk tunables) is baked into a single 0600 file at install time.
 */
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { AppConfigFile } from "@claude-transcripts/shared";
import type { EnvMap } from "./instance-env";
import { couchUrl } from "./provision";

export function buildHookConfig(app: AppConfigFile, env: EnvMap) {
  const user = env.COUCHDB_USER;
  return {
    couch: {
      url: couchUrl(env),
      databases: app.couchdb.databases,
      ...(user ? { auth: `${user}:${env.COUCHDB_PASSWORD ?? ""}` } : {}),
    },
    // Omitted entirely when S3 isn't provisioned yet — the hook checks for an access
    // key and simply doesn't upload blobs, rather than failing per event.
    blob: env.S3_ENDPOINT
      ? {
          endpoint: env.S3_ENDPOINT,
          region: env.S3_REGION || "garage",
          accessKey: env.S3_ACCESS_KEY,
          secretKey: env.S3_SECRET_KEY,
          buckets: app.s3.buckets,
        }
      : undefined,
    features: app.features,
    system: app.system,
  };
}

export function writeHookConfig(path: string, config: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`);
  chmodSync(path, 0o600);
}

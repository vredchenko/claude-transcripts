/**
 * Project the hook's runtime config from the app config + the instance env.
 *
 * This is the one file the hook itself reads, and nothing else writes it. It exists
 * because the hook runs as a separate short-lived process with no access to the
 * instance layout logic — so everything it needs (store URLs, credentials, feature
 * flags, chunk tunables) is baked into a single 0600 file at install time.
 */
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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

/**
 * Settings that are the machine's own, not projections of the instance config.
 *
 * Everything else in this file is derived — re-runnable from `config/` plus `.env`, so
 * a rewrite reproduces it exactly. `mirrors` is the exception: it names *other*
 * instances this machine reports into ([mirrors.md](../../../../docs/operate/mirrors.md)),
 * a fact no repo config knows and, for a binary install with no checkout, nothing else
 * on the machine records either. A plain rewrite would drop it silently and mirroring
 * would simply stop — the failure mode the whole feature is written to avoid.
 */
const PRESERVED_KEYS = ["mirrors"] as const;

function readExisting(path: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    // No file yet, or one we can't parse. Either way there is nothing to carry over,
    // and refusing to write would block a first install.
    return {};
  }
}

/**
 * Carry {@link PRESERVED_KEYS} forward from the file being replaced.
 *
 * An explicit value in `next` wins, so a caller that does know about a key can still
 * set or clear it; absence means "leave whatever the machine already had".
 */
export function mergePreserved(
  next: Record<string, unknown>,
  existing: Record<string, unknown>,
): Record<string, unknown> {
  const merged = { ...next };
  for (const key of PRESERVED_KEYS) {
    if (merged[key] === undefined && existing[key] !== undefined) merged[key] = existing[key];
  }
  return merged;
}

export function writeHookConfig(path: string, config: unknown): void {
  const merged = mergePreserved((config ?? {}) as Record<string, unknown>, readExisting(path));
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(merged, null, 2)}\n`);
  chmodSync(path, 0o600);
}

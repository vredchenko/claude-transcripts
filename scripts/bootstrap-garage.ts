#!/usr/bin/env bun
/**
 * One-command Garage bootstrap for the bundled dev stack.
 *
 *   bun run scripts/bootstrap-garage.ts        (or: bun run bootstrap:garage)
 *
 * S3 always signs requests, so a bucket + access key must exist before the app can
 * use object storage. This does the whole dance the README used to spell out by
 * hand: assign the single-node layout, create the sessions bucket + an app key,
 * grant it read/write, and write `S3_ACCESS_KEY` / `S3_SECRET_KEY` into `.env`.
 *
 * Idempotent: it no-ops if `.env` already has S3 keys, skips layout assignment if
 * a role is present, and reuses an existing bucket. Run it AFTER `stack:up`, while
 * Garage is healthy. It drives Garage's **v1 admin HTTP API** on
 * `GARAGE_ADMIN_PORT` (default 7654), authed with `GARAGE_ADMIN_TOKEN` — no
 * `docker exec`. (If your Garage version's admin API differs, the errors below print
 * the endpoint + response so it's easy to adjust; the CLI equivalents are in the
 * README.)
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfigFile } from "./lib/config-file";

const ROOT = join(import.meta.dir, "..");
const ENV_PATH = join(ROOT, ".env");
const env = process.env;

const ADMIN = `http://127.0.0.1:${env.GARAGE_ADMIN_PORT ?? "7654"}`;
const TOKEN = env.GARAGE_ADMIN_TOKEN ?? "";
const ZONE = "dc1";
const CAPACITY = 1_000_000_000; // 1 GB
const KEY_NAME = "claude-transcripts-app";

interface ApiResult {
  ok: boolean;
  status: number;
  // biome noExplicitAny is off repo-wide; admin API payloads are untyped here.
  json: any;
}

async function api(method: string, path: string, body?: unknown): Promise<ApiResult> {
  const res = await fetch(`${ADMIN}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${TOKEN}`,
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  }).catch((err) => {
    throw new Error(
      `admin API unreachable at ${ADMIN} — is the stack up and Garage healthy? (${err})`,
    );
  });
  const text = await res.text();
  let json: unknown = {};
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { raw: text };
  }
  return { ok: res.ok, status: res.status, json };
}

function fail(step: string, r: ApiResult): never {
  throw new Error(`${step} failed (HTTP ${r.status}): ${JSON.stringify(r.json).slice(0, 300)}`);
}

function sessionsBucket(): string {
  return loadConfigFile(ROOT).s3.buckets.sessions ?? "claude-transcripts-sessions";
}

async function main() {
  if (!TOKEN) {
    throw new Error(
      "GARAGE_ADMIN_TOKEN is empty in .env — generate it (openssl rand -hex 32), then start the stack.",
    );
  }

  // Already bootstrapped? Don't create duplicate keys.
  const envText = readFileSync(ENV_PATH, "utf8");
  if (/^S3_ACCESS_KEY=.+$/m.test(envText) && /^S3_SECRET_KEY=.+$/m.test(envText)) {
    console.log("[garage] .env already has S3_ACCESS_KEY/S3_SECRET_KEY — nothing to do.");
    return;
  }

  // 1. This node's id + current layout version.
  const status = await api("GET", "/v1/status");
  if (!status.ok) fail("cluster status", status);
  const nodeId: string | undefined = status.json.node;
  if (!nodeId)
    throw new Error(
      `could not read this node's id from /v1/status: ${JSON.stringify(status.json).slice(0, 200)}`,
    );
  console.log(`[garage] node ${nodeId.slice(0, 16)}…`);

  // 2. Layout: assign this node to a zone with capacity (unless it already has one).
  const layout = await api("GET", "/v1/layout");
  if (!layout.ok) fail("read layout", layout);
  const version: number = typeof layout.json.version === "number" ? layout.json.version : 0;
  const roles: unknown[] = Array.isArray(layout.json.roles) ? layout.json.roles : [];
  const hasRole = roles.some(
    (r) =>
      (r as { id?: string; capacity?: number }).id === nodeId &&
      Boolean((r as { capacity?: number }).capacity),
  );
  if (hasRole) {
    console.log("[garage] layout already assigned — skipping");
  } else {
    const assign = await api("POST", "/v1/layout", [
      { id: nodeId, zone: ZONE, capacity: CAPACITY, tags: [] },
    ]);
    if (!assign.ok) fail("layout assign", assign);
    const apply = await api("POST", "/v1/layout/apply", { version: version + 1 });
    if (!apply.ok) fail("layout apply", apply);
    console.log(`[garage] layout applied → v${version + 1}`);
  }

  // 3. Bucket (create, or find the existing one by alias).
  const bucket = sessionsBucket();
  const create = await api("POST", "/v1/bucket", { globalAlias: bucket });
  let bucketId: string | undefined;
  if (create.ok) {
    bucketId = create.json.id;
    console.log(`[garage] bucket created: ${bucket}`);
  } else {
    const found = await api("GET", `/v1/bucket?globalAlias=${encodeURIComponent(bucket)}`);
    if (!found.ok) fail("bucket lookup", found);
    bucketId = found.json.id;
    console.log(`[garage] bucket exists: ${bucket}`);
  }
  if (!bucketId) throw new Error(`could not resolve bucket id for "${bucket}"`);

  // 4. App key (fresh — we only get here when .env has no key yet).
  const key = await api("POST", "/v1/key", { name: KEY_NAME });
  if (!key.ok) fail("key create", key);
  const accessKey: string | undefined = key.json.accessKeyId;
  const secretKey: string | undefined = key.json.secretAccessKey;
  if (!accessKey || !secretKey)
    throw new Error(`key response missing credentials: ${JSON.stringify(key.json).slice(0, 200)}`);
  console.log(`[garage] app key created: ${accessKey}`);

  // 5. Grant read + write on the bucket.
  const allow = await api("POST", "/v1/bucket/allow", {
    bucketId,
    accessKeyId: accessKey,
    permissions: { read: true, write: true, owner: false },
  });
  if (!allow.ok) fail("bucket allow", allow);
  console.log("[garage] granted read+write");

  // 6. Persist the keys into .env (replace the empty assignments).
  const updated = envText
    .replace(/^S3_ACCESS_KEY=.*$/m, `S3_ACCESS_KEY=${accessKey}`)
    .replace(/^S3_SECRET_KEY=.*$/m, `S3_SECRET_KEY=${secretKey}`);
  writeFileSync(ENV_PATH, updated);
  console.log(
    "[garage] wrote S3_ACCESS_KEY + S3_SECRET_KEY to .env — restart the app to pick them up.",
  );
}

await main();

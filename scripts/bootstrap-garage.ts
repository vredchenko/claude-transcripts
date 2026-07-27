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
 * Garage is healthy. It drives Garage's **v2 admin HTTP API** (RPC-style `/v2/*`
 * operations — v1 is deprecated as of Garage 2.0) on `GARAGE_ADMIN_PORT` (default
 * 7654), authed with `GARAGE_ADMIN_TOKEN` — no `docker exec`. (If your Garage
 * version's admin API differs, the errors below print the endpoint + response so
 * it's easy to adjust; the CLI equivalents are in the README.)
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

  // 1. This node's id (GetClusterStatus.nodes[].id — single node in the bundled stack).
  const status = await api("GET", "/v2/GetClusterStatus");
  if (!status.ok) fail("cluster status", status);
  const nodes: any[] = Array.isArray(status.json.nodes) ? status.json.nodes : [];
  const self = nodes.find((n) => n?.id && n.isUp !== false) ?? nodes[0];
  const nodeId: string | undefined = self?.id;
  if (!nodeId)
    throw new Error(
      `could not read a node id from GetClusterStatus: ${JSON.stringify(status.json).slice(0, 200)}`,
    );
  console.log(`[garage] node ${nodeId.slice(0, 16)}…`);

  // 2. Layout: assign this node to a zone with capacity (unless it already has one).
  const layout = await api("GET", "/v2/GetClusterLayout");
  if (!layout.ok) fail("read layout", layout);
  const version: number = typeof layout.json.version === "number" ? layout.json.version : 0;
  const roles: unknown[] = Array.isArray(layout.json.roles) ? layout.json.roles : [];
  const hasRole = roles.some(
    (r) =>
      (r as { id?: string; capacity?: number | null }).id === nodeId &&
      Boolean((r as { capacity?: number | null }).capacity),
  );
  if (hasRole) {
    console.log("[garage] layout already assigned — skipping");
  } else {
    // UpdateClusterLayout stages the role change; ApplyClusterLayout commits it at
    // the next version (a safety check against concurrent edits).
    //
    // Body shape: Garage 2.3's OpenAPI spec (garage-admin-v2.json, `type:
    // UpdateClusterLayoutRequest`) wants an OBJECT — `{roles: [...]}`. Earlier 2.x
    // builds took the bare array inherited from the v1 `/v1/layout` endpoint. Try
    // the documented shape, then fall back, so one script covers both; a rejected
    // request stages nothing, so the retry is safe.
    const roleChange = { id: nodeId, zone: ZONE, capacity: CAPACITY, tags: [] };
    let assign = await api("POST", "/v2/UpdateClusterLayout", { roles: [roleChange] });
    if (!assign.ok) {
      const legacy = await api("POST", "/v2/UpdateClusterLayout", [roleChange]);
      if (!legacy.ok) {
        console.error(
          `[garage] bare-array body also rejected (HTTP ${legacy.status}): ` +
            `${JSON.stringify(legacy.json).slice(0, 200)}`,
        );
        fail("layout assign", assign);
      }
      console.log("[garage] layout staged via the legacy bare-array body");
      assign = legacy;
    }
    const apply = await api("POST", "/v2/ApplyClusterLayout", { version: version + 1 });
    if (!apply.ok) fail("layout apply", apply);
    console.log(`[garage] layout applied → v${version + 1}`);
  }

  // 3. Bucket (create, or find the existing one by alias).
  const bucket = sessionsBucket();
  const create = await api("POST", "/v2/CreateBucket", { globalAlias: bucket });
  let bucketId: string | undefined;
  if (create.ok) {
    bucketId = create.json.id;
    console.log(`[garage] bucket created: ${bucket}`);
  } else {
    const found = await api("GET", `/v2/GetBucketInfo?globalAlias=${encodeURIComponent(bucket)}`);
    if (!found.ok) fail("bucket lookup", found);
    bucketId = found.json.id;
    console.log(`[garage] bucket exists: ${bucket}`);
  }
  if (!bucketId) throw new Error(`could not resolve bucket id for "${bucket}"`);

  // 4. App key (fresh — we only get here when .env has no key yet).
  const key = await api("POST", "/v2/CreateKey", { name: KEY_NAME });
  if (!key.ok) fail("key create", key);
  const accessKey: string | undefined = key.json.accessKeyId;
  const secretKey: string | undefined = key.json.secretAccessKey;
  if (!accessKey || !secretKey)
    throw new Error(`key response missing credentials: ${JSON.stringify(key.json).slice(0, 200)}`);
  console.log(`[garage] app key created: ${accessKey}`);

  // 5. Grant read + write on the bucket.
  const allow = await api("POST", "/v2/AllowBucketKey", {
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

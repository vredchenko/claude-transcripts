/**
 * Provision the backing stores for an installed instance.
 *
 * CouchDB databases and Garage's bucket + access key. Meilisearch needs nothing here —
 * the webapi creates its indexes at boot with the right settings, and `reindex`
 * rebuilds them.
 *
 * The ordering constraint that makes this its own phase: **Garage's S3 credentials do
 * not exist until Garage is running.** They're created here and written back into the
 * instance env, which is why anything holding them (the app container) has to start
 * afterwards. The dev scripts only get away with ignoring this because a human is
 * driving them in sequence.
 *
 * Everything is idempotent: databases that exist are left alone, a node that already
 * has a layout role isn't reassigned, an existing bucket is reused, and keys are only
 * created when the instance env has none.
 */
import type { EnvMap } from "./instance-env";
import { updateInstanceEnv } from "./instance-env";

export interface ProvisionStep {
  name: string;
  ok: boolean;
  detail: string;
}

// ── CouchDB ──────────────────────────────────────────────────────────────────

function couchAuthHeader(env: EnvMap): Record<string, string> {
  const user = env.COUCHDB_USER;
  if (!user) return {};
  return { authorization: `Basic ${btoa(`${user}:${env.COUCHDB_PASSWORD ?? ""}`)}` };
}

export function couchUrl(env: EnvMap): string {
  return env.COUCHDB_URL || `http://${env.COUCHDB_HOST || "127.0.0.1"}:${env.COUCHDB_PORT}`;
}

/** Create each configured database. 412 means it already exists — that's success. */
export async function provisionCouch(env: EnvMap, databases: string[]): Promise<ProvisionStep[]> {
  const base = couchUrl(env);
  const headers = { "content-type": "application/json", ...couchAuthHeader(env) };
  const steps: ProvisionStep[] = [];
  for (const name of databases) {
    const res = await fetch(`${base}/${encodeURIComponent(name)}`, { method: "PUT", headers });
    if (res.status === 201) steps.push({ name: `couch:${name}`, ok: true, detail: "created" });
    else if (res.status === 412) steps.push({ name: `couch:${name}`, ok: true, detail: "exists" });
    else {
      steps.push({
        name: `couch:${name}`,
        ok: false,
        detail: `HTTP ${res.status} ${res.statusText}`,
      });
    }
  }
  return steps;
}

// ── Garage ───────────────────────────────────────────────────────────────────

interface ApiResult {
  ok: boolean;
  status: number;
  json: any;
}

const ZONE = "dc1";
const CAPACITY = 1_000_000_000; // 1 GB
const KEY_NAME = "claude-transcripts-app";

function garageApi(env: EnvMap) {
  const admin = `http://127.0.0.1:${env.GARAGE_ADMIN_PORT}`;
  const token = env.GARAGE_ADMIN_TOKEN ?? "";
  return async function api(method: string, path: string, body?: unknown): Promise<ApiResult> {
    const res = await fetch(`${admin}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body ? { "content-type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    }).catch((err) => {
      throw new Error(`Garage admin API unreachable at ${admin} — is Garage healthy? (${err})`);
    });
    const text = await res.text();
    let json: unknown = {};
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      json = { raw: text };
    }
    return { ok: res.ok, status: res.status, json };
  };
}

/**
 * Assign this node a layout role, if it hasn't got one.
 *
 * `UpdateClusterLayout` stages the change and `ApplyClusterLayout` commits it at the
 * next version. Garage 2.3's spec wants an object (`{roles: [...]}`) where earlier 2.x
 * builds took a bare array; a rejected request stages nothing, so trying the
 * documented shape and falling back is safe and covers both.
 */
async function ensureLayout(api: ReturnType<typeof garageApi>): Promise<string> {
  const status = await api("GET", "/v2/GetClusterStatus");
  if (!status.ok) throw new Error(`Garage cluster status failed (HTTP ${status.status})`);
  const nodes: any[] = Array.isArray(status.json.nodes) ? status.json.nodes : [];
  const self = nodes.find((n) => n?.id && n.isUp !== false) ?? nodes[0];
  const nodeId: string | undefined = self?.id;
  if (!nodeId) throw new Error("could not read a Garage node id from GetClusterStatus");

  const layout = await api("GET", "/v2/GetClusterLayout");
  if (!layout.ok) throw new Error(`Garage layout read failed (HTTP ${layout.status})`);
  const version: number = typeof layout.json.version === "number" ? layout.json.version : 0;
  const roles: any[] = Array.isArray(layout.json.roles) ? layout.json.roles : [];
  if (roles.some((r) => r?.id === nodeId && Boolean(r?.capacity))) return "layout already assigned";

  const roleChange = { id: nodeId, zone: ZONE, capacity: CAPACITY, tags: [] };
  let assign = await api("POST", "/v2/UpdateClusterLayout", { roles: [roleChange] });
  if (!assign.ok) {
    const legacy = await api("POST", "/v2/UpdateClusterLayout", [roleChange]);
    if (!legacy.ok) throw new Error(`Garage layout assign failed (HTTP ${assign.status})`);
    assign = legacy;
  }
  const apply = await api("POST", "/v2/ApplyClusterLayout", { version: version + 1 });
  if (!apply.ok) throw new Error(`Garage layout apply failed (HTTP ${apply.status})`);
  return `layout applied → v${version + 1}`;
}

/**
 * Ensure the bucket + an app key with read/write, and persist the credentials.
 *
 * Keys are only minted when the instance env has none: they can't be read back out of
 * Garage afterwards, so minting on every run would orphan the previous key and leave
 * the store unreachable with the credentials we just overwrote.
 */
export async function provisionGarage(
  env: EnvMap,
  bucket: string,
  instanceEnvPath: string,
): Promise<{ steps: ProvisionStep[]; env: EnvMap }> {
  const api = garageApi(env);
  const steps: ProvisionStep[] = [];

  if (!env.GARAGE_ADMIN_TOKEN) {
    return {
      steps: [{ name: "garage", ok: false, detail: "GARAGE_ADMIN_TOKEN is empty" }],
      env,
    };
  }

  steps.push({ name: "garage:layout", ok: true, detail: await ensureLayout(api) });

  const create = await api("POST", "/v2/CreateBucket", { globalAlias: bucket });
  let bucketId: string | undefined = create.ok ? create.json.id : undefined;
  if (create.ok) {
    steps.push({ name: `garage:bucket`, ok: true, detail: `created ${bucket}` });
  } else {
    const found = await api("GET", `/v2/GetBucketInfo?globalAlias=${encodeURIComponent(bucket)}`);
    if (!found.ok) throw new Error(`Garage bucket lookup failed (HTTP ${found.status})`);
    bucketId = found.json.id;
    steps.push({ name: `garage:bucket`, ok: true, detail: `exists ${bucket}` });
  }
  if (!bucketId) throw new Error(`could not resolve a bucket id for "${bucket}"`);

  if (env.S3_ACCESS_KEY && env.S3_SECRET_KEY) {
    steps.push({ name: "garage:key", ok: true, detail: "already provisioned" });
    return { steps, env };
  }

  const key = await api("POST", "/v2/CreateKey", { name: KEY_NAME });
  if (!key.ok) throw new Error(`Garage key creation failed (HTTP ${key.status})`);
  const accessKey: string | undefined = key.json.accessKeyId;
  const secretKey: string | undefined = key.json.secretAccessKey;
  if (!accessKey || !secretKey) throw new Error("Garage key response carried no credentials");

  const allow = await api("POST", "/v2/AllowBucketKey", {
    bucketId,
    accessKeyId: accessKey,
    permissions: { read: true, write: true, owner: false },
  });
  if (!allow.ok) throw new Error(`Garage grant failed (HTTP ${allow.status})`);

  const next = updateInstanceEnv(instanceEnvPath, {
    S3_ACCESS_KEY: accessKey,
    S3_SECRET_KEY: secretKey,
  });
  steps.push({ name: "garage:key", ok: true, detail: `created ${accessKey}` });
  return { steps, env: next };
}

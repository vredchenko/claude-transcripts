/**
 * The Helm chart's provisioning hook. Hand-written; scripts/gen-helm.ts copies it into the
 * chart (files/provision.ts) and the Job runs it with the app image's Bun:
 *
 *   bun /provision/provision.ts
 *
 * 1. Runs the CLI's own `claude-transcripts provision` against the in-cluster services:
 *    CouchDB's databases, Garage's layout, the bucket and an app key. The Job's env (the
 *    env Secret, plus COUCHDB_URL / GARAGE_ADMIN_URL) becomes a throwaway instance env,
 *    which is all `provision` reads.
 * 2. If that minted a key, stores it in its own Secret (CT_S3_SECRET) and restarts the
 *    app (CT_APP_DEPLOYMENT) so it picks the key up. The chart never renders that
 *    Secret, so neither `helm upgrade` nor a GitOps sync can overwrite it.
 *
 * Idempotent: with the S3 Secret present, `provision` finds the key already there and
 * mints nothing, so this runs after every install and upgrade.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

const env = process.env;
const HOME = "/tmp/claude-transcripts";
const INSTANCE_ENV = `${HOME}/config/instance.env`;

mkdirSync(`${HOME}/config`, { recursive: true });
writeFileSync(
  INSTANCE_ENV,
  `${Object.entries(env)
    .filter(([k, v]) => /^(COUCHDB|GARAGE|S3|MEILI|FOSSIL)_/.test(k) && v !== undefined)
    .map(([k, v]) => `${k}=${v}`)
    .join("\n")}\n`,
);

const run = Bun.spawnSync(["claude-transcripts", "provision"], {
  env: { ...env, CT_HOME: HOME },
  stdout: "inherit",
  stderr: "inherit",
});
if (run.exitCode !== 0) process.exit(run.exitCode ?? 1);

const minted = Object.fromEntries(
  readFileSync(INSTANCE_ENV, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#") && l.includes("="))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
) as Record<string, string>;

if (env.S3_ACCESS_KEY || !minted.S3_ACCESS_KEY || !minted.S3_SECRET_KEY) {
  console.log("[provision] S3 key already in place");
  process.exit(0);
}

// ── hand the key to the cluster ────────────────────────────────────────────────
const SA = "/var/run/secrets/kubernetes.io/serviceaccount";
const ns = readFileSync(`${SA}/namespace`, "utf8").trim();
const token = readFileSync(`${SA}/token`, "utf8").trim();
const ca = readFileSync(`${SA}/ca.crt`, "utf8");
const apiBase = `https://${env.KUBERNETES_SERVICE_HOST}:${env.KUBERNETES_SERVICE_PORT}`;

async function kube(method: string, path: string, body: unknown, type = "application/json") {
  const res = await fetch(`${apiBase}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, "content-type": type },
    body: JSON.stringify(body),
    tls: { ca },
  });
  if (!res.ok && res.status !== 409) {
    throw new Error(`${method} ${path}: HTTP ${res.status} ${await res.text()}`);
  }
  return res.status;
}

const secretName = env.CT_S3_SECRET ?? "claude-transcripts-s3";
const stringData = { S3_ACCESS_KEY: minted.S3_ACCESS_KEY, S3_SECRET_KEY: minted.S3_SECRET_KEY };
const created = await kube("POST", `/api/v1/namespaces/${ns}/secrets`, {
  apiVersion: "v1",
  kind: "Secret",
  metadata: { name: secretName, labels: { "app.kubernetes.io/part-of": "claude-transcripts" } },
  type: "Opaque",
  stringData,
});
if (created === 409) {
  await kube(
    "PATCH",
    `/api/v1/namespaces/${ns}/secrets/${secretName}`,
    { stringData },
    "application/merge-patch+json",
  );
}
console.log(`[provision] stored the S3 key in Secret ${secretName}`);

const deployment = env.CT_APP_DEPLOYMENT ?? "app";
await kube(
  "PATCH",
  `/apis/apps/v1/namespaces/${ns}/deployments/${deployment}`,
  {
    spec: {
      template: {
        metadata: {
          annotations: { "claude-transcripts/provisioned-at": new Date().toISOString() },
        },
      },
    },
  },
  "application/strategic-merge-patch+json",
);
console.log(`[provision] restarted ${deployment} to pick it up`);

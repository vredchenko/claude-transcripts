#!/usr/bin/env bun
/**
 * Smoke-test the Helm chart (deploy/helm/claude-transcripts) on whatever cluster kubectl
 * points at: install it, check that provisioning minted the S3 key and the app uses it,
 * then upgrade and check that nothing was rotated or re-minted. Dev-only tooling; CI runs
 * it on a kind cluster (chart.yml).
 *
 *   bun run helm:smoke [-- --set images.app=<ref> ...]
 *
 * Extra arguments go to `helm install` and `helm upgrade`. Installs into a scratch
 * namespace and deletes it on exit, pass or fail (with the pods and logs printed on
 * failure). Needs helm and kubectl on PATH and a free local port 17650.
 */
import { join } from "node:path";
import { $ } from "bun";

const ROOT = join(import.meta.dir, "..");
const CHART = join(ROOT, "deploy", "helm", "claude-transcripts");
const NS = `ct-smoke-${process.pid}`;
const RELEASE = "ct";
const EXTRA = process.argv.slice(2);
const LOCAL_PORT = 17650;

let step = "";
function check(cond: unknown, what: string): asserts cond {
  if (!cond) throw new Error(`${step}: ${what}`);
  console.log(`  ok  ${what}`);
}

const kubectl = (...args: string[]) => $`kubectl -n ${NS} ${args}`.quiet();
async function secretValue(name: string, key: string): Promise<string> {
  const out = await $`kubectl -n ${NS} get secret ${name} -o jsonpath=${`{.data.${key}}`}`
    .nothrow()
    .quiet();
  return out.exitCode === 0 ? Buffer.from(out.text(), "base64").toString() : "";
}

async function helm(verb: "install" | "upgrade"): Promise<void> {
  // --wait: workloads ready before the post-install hook (provisioning) runs.
  await $`helm ${verb} ${RELEASE} ${CHART} -n ${NS} ${verb === "install" ? ["--create-namespace"] : []} --wait --timeout 15m ${EXTRA}`;
}

/** The app through a port-forward, for as long as `fn` runs. */
async function withApp<T>(fn: (base: string) => Promise<T>): Promise<T> {
  // The provisioning Job restarted the app; wait for that rollout before forwarding.
  await kubectl("rollout", "status", "deployment/app", "--timeout=300s");
  const pf = Bun.spawn(["kubectl", "-n", NS, "port-forward", "svc/app", `${LOCAL_PORT}:7650`], {
    stdout: "ignore",
    stderr: "ignore",
  });
  const base = `http://127.0.0.1:${LOCAL_PORT}`;
  try {
    for (let i = 0; i < 30; i++) {
      if (
        await fetch(`${base}/health`).then(
          (r) => r.ok,
          () => false,
        )
      )
        break;
      await Bun.sleep(1000);
    }
    return await fn(base);
  } finally {
    pf.kill();
  }
}

async function main(): Promise<void> {
  step = "install";
  console.log(`[smoke-helm] ${step} into ${NS}`);
  await helm("install");

  const job = (await kubectl("get", "job", "claude-transcripts-provision", "-o", "name").nothrow())
    .exitCode;
  check(job !== 0, "provisioning Job succeeded and was cleaned up");
  const access = await secretValue("claude-transcripts-s3", "S3_ACCESS_KEY");
  check(access.startsWith("GK"), `S3 key minted into its own Secret (${access})`);
  const password = await secretValue("claude-transcripts-env", "COUCHDB_PASSWORD");
  check(password.length === 32, "CouchDB password generated");

  const body = '{"type":"user","smoke":true}\n';
  const id = `smoke-${Date.now()}`;
  await withApp(async (base) => {
    const health = (await (await fetch(`${base}/health`)).json()) as { ok?: boolean };
    check(health.ok === true, "webapi /health reports ok");
    const put = await fetch(`${base}/api/ingest/${id}/transcript`, {
      method: "PUT",
      headers: { "content-type": "text/plain" },
      body,
    });
    check(put.ok, "transcript written through /api/ingest");
    const got = await (await fetch(`${base}/api/s3/sessions/${id}/transcript.jsonl`)).text();
    check(got === body, "and read back from S3 with the minted key");
  });

  step = "upgrade";
  console.log(`[smoke-helm] ${step} (same values)`);
  await helm("upgrade");
  check(
    (await secretValue("claude-transcripts-env", "COUCHDB_PASSWORD")) === password,
    "CouchDB password kept",
  );
  check(
    (await secretValue("claude-transcripts-s3", "S3_ACCESS_KEY")) === access,
    "S3 key kept, nothing re-minted",
  );
  await withApp(async (base) => {
    const got = await (await fetch(`${base}/api/s3/sessions/${id}/transcript.jsonl`)).text();
    check(got === body, "data survived the upgrade");
  });

  console.log("[smoke-helm] pass");
}

try {
  await main();
} catch (err) {
  console.error(`[smoke-helm] FAIL — ${(err as Error).message}`);
  console.error((await $`kubectl -n ${NS} get pods,jobs,pvc`.nothrow().quiet()).text());
  console.error(
    (
      await $`kubectl -n ${NS} logs -l app.kubernetes.io/name=provision --tail=60`.nothrow().quiet()
    ).text(),
  );
  console.error((await $`kubectl -n ${NS} logs deployment/app --tail=40`.nothrow().quiet()).text());
  process.exitCode = 1;
} finally {
  await $`helm uninstall ${RELEASE} -n ${NS} --wait`.nothrow().quiet();
  await $`kubectl delete namespace ${NS} --wait=false`.nothrow().quiet();
}

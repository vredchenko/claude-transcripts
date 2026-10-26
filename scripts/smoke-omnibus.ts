#!/usr/bin/env bun
/**
 * Smoke-test an omnibus image: boot it on an empty volume, check every surface it
 * claims, then recreate the container on the same volume and check that nothing was
 * lost or re-provisioned. Dev-only tooling; CI runs it (omnibus.yml, publish-image.yml).
 *
 *   bun run omnibus:smoke [image]        # default claude-transcripts-omnibus:local
 *
 * Needs docker and a free 127.0.0.1:7650. Leaves nothing behind: the container and
 * volume are removed on exit, pass or fail (the logs are printed on failure).
 */
import { $ } from "bun";

const IMAGE = process.argv[2] ?? "claude-transcripts-omnibus:local";
const RUN = `ct-omnibus-smoke-${process.pid}`;
const VOLUME = `${RUN}-data`;
const PORT = process.env.SMOKE_PORT ?? "7650";
const BASE = `http://127.0.0.1:${PORT}`;
const HEALTHY_WITHIN_S = Number(process.env.SMOKE_TIMEOUT_S ?? 300);

let step = "";
function check(cond: unknown, what: string): asserts cond {
  if (!cond) throw new Error(`${step}: ${what}`);
  console.log(`  ok  ${what}`);
}

async function start(): Promise<void> {
  await $`docker run -d --name ${RUN} -p 127.0.0.1:${PORT}:7650 -v ${VOLUME}:/data -e OMNIBUS_GIT_FETCH=0 ${IMAGE}`.quiet();
  const deadline = Date.now() + HEALTHY_WITHIN_S * 1000;
  for (;;) {
    const state = (
      await $`docker inspect -f {{.State.Status}}/{{.State.Health.Status}} ${RUN}`.text()
    ).trim();
    if (state === "running/healthy") break;
    if (!state.startsWith("running")) throw new Error(`${step}: container stopped (${state})`);
    if (Date.now() > deadline)
      throw new Error(`${step}: not healthy after ${HEALTHY_WITHIN_S}s (${state})`);
    await Bun.sleep(2000);
  }
  console.log(`  ok  healthy`);
}

async function stop(): Promise<void> {
  await $`docker rm -f ${RUN}`.quiet().nothrow();
}

const exec = (...cmd: string[]) => $`docker exec ${RUN} ${cmd}`.nothrow().quiet();
const secret = async (name: string) => (await exec("cat", `/data/secrets/${name}`)).text();
const get = (path: string, init?: RequestInit) => fetch(`${BASE}${path}`, init);

async function main(): Promise<void> {
  step = "first boot";
  console.log(`[smoke] ${IMAGE} — ${step}`);
  await start();

  const health = (await (await get("/health")).json()) as { ok?: boolean };
  check(health.ok === true, "webapi /health reports ok");
  check((await exec("omnibus-health")).exitCode === 0, "omnibus-health: every service answers");
  check((await get("/app/")).ok, "webui at /app/");
  check((await get("/docs/")).ok, "docs at /docs/");

  for (const plat of ["linux-x64", "linux-arm64", "darwin-x64", "darwin-arm64"]) {
    const name = `claude-transcripts-${plat}`;
    const bin = new Uint8Array(await (await get(`/downloads/${name}`)).arrayBuffer());
    const sum = (await (await get(`/downloads/${name}.sha256`)).text()).split(/\s+/)[0];
    check(bin.length > 1_000_000, `/downloads/${name} is a binary`);
    check(
      new Bun.CryptoHasher("sha256").update(bin).digest("hex") === sum,
      `${name} matches its .sha256`,
    );
  }
  const plugin = await get("/downloads/claude-transcripts-plugin.tar.gz");
  check(plugin.ok, "/downloads/ has the plugin bundle");

  const version = (await exec("claude-transcripts", "--version")).text().trim();
  check(version.length > 0, `CLI on PATH (${version})`);
  check((await exec("claude-transcripts", "sessions")).exitCode === 0, "CLI reaches the webapi");
  check((await exec("gh", "--version")).exitCode === 0, "gh installed");

  const push =
    await $`docker exec ${RUN} sh -c ${"git init -q --bare /tmp/r.git && git -C /workspace/claude-transcripts push /tmp/r.git HEAD:refs/heads/x"}`
      .nothrow()
      .quiet();
  check(
    push.exitCode !== 0 && push.stderr.toString().includes("push is disabled"),
    "git push refused",
  );

  // A transcript write lands in Garage (via the bootstrapped app key) and reads back.
  const id = `smoke-${Date.now()}`;
  const body = '{"type":"user","smoke":true}\n';
  const put = await get(`/api/ingest/${id}/transcript`, {
    method: "PUT",
    headers: { "content-type": "text/plain" },
    body,
  });
  check(put.ok, "transcript written through /api/ingest");
  check(
    (await (await get(`/api/s3/sessions/${id}/transcript.jsonl`)).text()) === body,
    "and read back from S3",
  );

  const before = await secret("COUCHDB_PASSWORD");
  const s3Before = await secret("s3.env");

  step = "second boot";
  console.log(`[smoke] ${step} (same volume)`);
  await stop();
  await start();
  check((await secret("COUCHDB_PASSWORD")) === before, "CouchDB password reused");
  check((await secret("s3.env")) === s3Before, "S3 key reused");
  check(
    (await (await get(`/api/s3/sessions/${id}/transcript.jsonl`)).text()) === body,
    "data survived",
  );
  const logs = (await $`docker logs ${RUN}`.nothrow().quiet()).text();
  check(logs.includes("nothing to do"), "Garage bootstrap was a no-op");

  console.log("[smoke] pass");
}

try {
  await main();
} catch (err) {
  console.error(`[smoke] FAIL — ${(err as Error).message}`);
  console.error((await $`docker logs ${RUN}`.nothrow().quiet()).text().slice(-8000));
  process.exitCode = 1;
} finally {
  await stop();
  await $`docker volume rm ${VOLUME}`.quiet().nothrow();
}

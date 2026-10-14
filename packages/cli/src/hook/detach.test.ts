/**
 * The SessionEnd transcript upload runs detached so Claude Code's exit budget can't
 * cancel it (#217). Three things have to hold:
 *
 *   - the child survives its parent's whole process group being killed — what Claude
 *     Code does to a hook that runs out of budget;
 *   - `hook run` on SessionEnd returns without waiting for the upload, and the upload
 *     still lands;
 *   - if the child cannot start, the upload runs in-line as it used to.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HANDLERS } from "./handlers";
import { buildContext, type HookConfig } from "./runtime";

const ENTRY = join(import.meta.dir, "..", "cli.tsx");
const DETACH = join(import.meta.dir, "detach.ts");
const dir = mkdtempSync(join(tmpdir(), "ct-detach-"));
const posix = process.platform !== "win32";

async function waitFor(check: () => boolean, ms: number): Promise<boolean> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (check()) return true;
    await Bun.sleep(50);
  }
  return check();
}

describe.if(posix)("spawnDetached", () => {
  test("the child outlives a SIGKILL to the parent's process group", async () => {
    const out = join(dir, "survived");
    const script = `
      import { spawnDetached } from ${JSON.stringify(DETACH)};
      spawnDetached(["sh", "-c", "sleep 1; echo ok > ${out}"]);
      console.log("started");
      await Bun.sleep(60_000);
    `;
    // `detached` so the parent leads its own group, which is then killed whole.
    const { spawn } = await import("node:child_process");
    const parent = spawn("bun", ["-e", script], {
      detached: true,
      stdio: ["ignore", "pipe", "inherit"],
    });
    await new Promise<void>((resolve) => parent.stdout?.once("data", () => resolve()));
    process.kill(-(parent.pid as number), "SIGKILL");

    expect(existsSync(out)).toBe(false);
    expect(await waitFor(() => existsSync(out), 5_000)).toBe(true);
  });
});

describe.if(posix)("SessionEnd through `hook run`", () => {
  const SLOW_MS = 1_500;
  const uploads: { path: string; body: string }[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (req.method === "PUT" && url.pathname.endsWith("/transcript")) {
        const body = await req.text();
        // Slower than the hook is allowed to be: if `hook run` waited on this, it
        // would not have exited by the time the upload lands.
        await Bun.sleep(SLOW_MS);
        uploads.push({ path: url.pathname, body });
        return new Response(null, { status: 201 });
      }
      // Couch writes and mirror ingest of docs: accept everything.
      return Response.json({ ok: true }, { status: 201 });
    },
  });
  afterAll(() => server.stop(true));

  test("returns before the upload finishes, and the upload lands", async () => {
    const base = `http://localhost:${server.port}`;
    const config: HookConfig = {
      couch: { url: base, databases: { sessions: "s" } },
      // No local S3 key: the blob goes only to the mirror, which this server plays.
      blob: { endpoint: base, region: "auto", buckets: { sessions: "b" } },
      mirrors: [{ url: base }],
      features: {},
      system: { logging: { chunk: { maxEntriesPerChunk: 200, flushIntervalMs: 15_000 } } },
    };
    const configPath = join(dir, "config.json");
    writeFileSync(configPath, JSON.stringify(config));
    const sid = `test-detach-${crypto.randomUUID()}`;
    const transcript = join(dir, `${sid}.jsonl`);
    const content = `${JSON.stringify({ type: "user", message: "hello" })}\n`;
    writeFileSync(transcript, content);

    const proc = Bun.spawn(["bun", "run", ENTRY, "hook", "run"], {
      stdin: new Response(
        JSON.stringify({
          hook_event_name: "SessionEnd",
          session_id: sid,
          transcript_path: transcript,
          cwd: dir,
          reason: "exit",
        }),
      ),
      stdout: "ignore",
      stderr: "ignore",
      env: { ...process.env, CT_HOOK_CONFIG: configPath },
    });
    expect(await proc.exited).toBe(0);
    // The hook is gone and the upload has not finished: it did not wait.
    expect(uploads).toEqual([]);

    expect(await waitFor(() => uploads.length > 0, 10_000)).toBe(true);
    expect(uploads[0]?.path).toBe(`/api/ingest/${sid}/transcript`);
    expect(uploads[0]?.body).toBe(content);
  }, 20_000);
});

describe("upload-blobs", () => {
  test("uploads in-line when the detached child cannot start", async () => {
    const transcript = join(dir, "inline.jsonl");
    writeFileSync(transcript, "{}\n");
    const config: HookConfig = {
      couch: { url: "http://localhost:1", databases: {} },
      blob: { endpoint: "http://localhost:1", region: "auto", buckets: { sessions: "b" } },
      features: {},
      system: { logging: { chunk: { maxEntriesPerChunk: 200, flushIntervalMs: 15_000 } } },
    };
    const ctx = buildContext(
      { hook_event_name: "SessionEnd", session_id: "s1", transcript_path: transcript },
      config,
    );
    if (!ctx) throw new Error("no context");
    const puts: string[] = [];
    ctx.blob = { enabled: true, put: async (_b, key) => void puts.push(key) };

    ctx.detachUpload = () => true;
    await HANDLERS["upload-blobs"]?.(ctx);
    expect(puts).toEqual([]);

    ctx.detachUpload = () => false;
    await HANDLERS["upload-blobs"]?.(ctx);
    expect(puts).toEqual(["s1/transcript.jsonl"]);
  });
});

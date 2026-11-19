/**
 * Resuming an ended session must not re-chunk what is already stored (#168). Real
 * handlers against a fake webapi: first-write-wins chunk ingest and the high-water route.
 */
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HANDLERS } from "./handlers";
import { fetchChunkHighWater } from "./ingest";
import { buildContext, type HookConfig, makeChunkState } from "./runtime";

const docs = new Map<string, Record<string, unknown>>();
let highWaterQueries = 0;
let mode: "ok" | "error" | "slow" = "ok";

/** The webapi's `GET /api/ingest/{id}/high-water`: the furthest `byte_end` of its chunks. */
function highWater(sid: string): number {
  return Math.max(
    0,
    ...[...docs.values()]
      .filter((d) => d.type === "chunk" && d.session_id === sid)
      .map((d) => d.byte_end as number),
  );
}

const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const url = new URL(req.url);
    const hw = url.pathname.match(/^\/api\/ingest\/([^/]+)\/high-water$/);
    if (req.method === "GET" && hw) {
      highWaterQueries++;
      if (mode === "error") return new Response("boom", { status: 500 });
      if (mode === "slow") await Bun.sleep(500);
      const sid = decodeURIComponent(hw[1] as string);
      return Response.json({ id: sid, bytes: highWater(sid) });
    }
    if (req.method === "POST" && url.pathname === "/api/ingest/chunks") {
      // Stable ids, first write wins — a re-flush conflicts benignly, as CouchDB does.
      const { docs: batch } = (await req.json()) as { docs: Record<string, unknown>[] };
      for (const d of batch) if (!docs.has(d._id as string)) docs.set(d._id as string, d);
      return Response.json({ ok: true });
    }
    if (req.method === "POST") return Response.json({ ok: true });
    return new Response("nope", { status: 405 });
  },
});

const dir = mkdtempSync(join(tmpdir(), "ct-chunk-resume-"));
const sessions: string[] = [];

afterEach(() => {
  docs.clear();
  highWaterQueries = 0;
  mode = "ok";
});
afterAll(() => {
  server.stop(true);
  for (const sid of sessions) {
    for (const ext of ["chunkstate", "chunklock", "counts", "targets"]) {
      try {
        unlinkSync(`/tmp/claude-transcripts-${sid}.${ext}`);
      } catch {
        // never written
      }
    }
  }
});

const config = (url = `http://localhost:${server.port}`): HookConfig => ({
  webapi: { url },
  features: { midFlightChunking: true },
  // Two entries per chunk and a flush interval that never elapses inside a test, so
  // boundaries are decided by the entry count alone — deterministic.
  system: { logging: { chunk: { maxEntriesPerChunk: 2, flushIntervalMs: 3_600_000 } } },
});

function newSession(): { sid: string; transcript: string } {
  const sid = `test-resume-${crypto.randomUUID()}`;
  sessions.push(sid);
  const transcript = join(dir, `${sid}.jsonl`);
  writeFileSync(transcript, "");
  return { sid, transcript };
}

function appendEntries(path: string, n: number, tag: string): void {
  for (let i = 0; i < n; i++) {
    appendFileSync(path, `${JSON.stringify({ type: "user", tag, i, pad: "x".repeat(i * 7) })}\n`);
  }
}

async function fire(
  event: string,
  sid: string,
  transcript: string,
  extra: Record<string, unknown> = {},
  cfg: HookConfig = config(),
): Promise<void> {
  const ctx = buildContext(
    { hook_event_name: event, session_id: sid, transcript_path: transcript, cwd: dir, ...extra },
    cfg,
  );
  if (!ctx) throw new Error("no context");
  const key = event === "SessionStart" ? "seed-session-start" : "flush-transcript-chunk";
  await HANDLERS[key]?.(ctx);
}

/** This session's stored chunks as `[byte_start, byte_end]`, in byte order. */
function ranges(sid: string): [number, number][] {
  return [...docs.values()]
    .filter((d) => d.type === "chunk" && d.session_id === sid)
    .map((d) => [d.byte_start as number, d.byte_end as number] as [number, number])
    .sort((x, y) => x[0] - y[0]);
}

/** Chunks tile [0, size) exactly: no gaps, and — the bug — no overlaps. */
function expectTiles(sid: string, size: number): void {
  const r = ranges(sid);
  expect(r[0]?.[0]).toBe(0);
  for (let i = 1; i < r.length; i++) expect(r[i]?.[0]).toBe(r[i - 1]?.[1] as number);
  expect(r[r.length - 1]?.[1]).toBe(size);
}

/** Run a session to its end: 5 entries → chunks of 2, 2, then the forced tail of 1. */
async function runAndEnd(sid: string, transcript: string): Promise<number> {
  await fire("SessionStart", sid, transcript, { source: "startup" });
  appendEntries(transcript, 5, "first");
  await fire("UserPromptSubmit", sid, transcript);
  await fire("SessionEnd", sid, transcript);
  return statSync(transcript).size;
}

describe("SessionEnd", () => {
  test("keeps the chunk offset and releases only the lock", async () => {
    const { sid, transcript } = newSession();
    const size = await runAndEnd(sid, transcript);

    expect(makeChunkState(sid).load().offset).toBe(size);
    // The lock is free: a resumed session's first flush must not be skipped.
    expect(makeChunkState(sid).acquire()).toBe(true);
    makeChunkState(sid).release();
  });

  test("a resume after it continues from the stored boundary — no duplicate chunks", async () => {
    const { sid, transcript } = newSession();
    const ended = await runAndEnd(sid, transcript);
    expect(ranges(sid)).toHaveLength(3);

    await fire("SessionStart", sid, transcript, { source: "resume" });
    // A local offset was there, so the webapi was never asked.
    expect(highWaterQueries).toBe(0);
    appendEntries(transcript, 3, "resumed");
    await fire("Stop", sid, transcript);

    const size = statSync(transcript).size;
    expectTiles(sid, size);
    expect(ranges(sid).filter(([start]) => start >= ended)).toHaveLength(2);
  });
});

describe("resume with the local chunk state lost (e.g. a reboot)", () => {
  test("seeds the offset from the webapi's high-water mark", async () => {
    const { sid, transcript } = newSession();
    const ended = await runAndEnd(sid, transcript);
    unlinkSync(`/tmp/claude-transcripts-${sid}.chunkstate`);

    await fire("SessionStart", sid, transcript, { source: "resume" });
    expect(highWaterQueries).toBe(1);
    expect(makeChunkState(sid).load().offset).toBe(ended);

    appendEntries(transcript, 3, "resumed");
    await fire("Stop", sid, transcript);
    expectTiles(sid, statSync(transcript).size);
  });

  test("a high-water past the end of a rewritten transcript is ignored", async () => {
    const { sid, transcript } = newSession();
    await runAndEnd(sid, transcript);
    unlinkSync(`/tmp/claude-transcripts-${sid}.chunkstate`);
    writeFileSync(transcript, "");

    await fire("SessionStart", sid, transcript, { source: "resume" });
    expect(makeChunkState(sid).load().offset).toBe(0);
  });

  test("a local offset past the end of the file falls back to the webapi", async () => {
    const { sid, transcript } = newSession();
    const ended = await runAndEnd(sid, transcript);
    makeChunkState(sid).save({ offset: ended + 1_000, lastFlushMs: 1 });

    await fire("SessionStart", sid, transcript, { source: "resume" });
    expect(makeChunkState(sid).load().offset).toBe(ended);
  });

  test("compact is treated the same as resume", async () => {
    const { sid, transcript } = newSession();
    const ended = await runAndEnd(sid, transcript);
    unlinkSync(`/tmp/claude-transcripts-${sid}.chunkstate`);

    await fire("SessionStart", sid, transcript, { source: "compact" });
    expect(makeChunkState(sid).load().offset).toBe(ended);
  });

  test("an unreachable webapi falls back to offset 0 without throwing", async () => {
    const { sid, transcript } = newSession();
    await runAndEnd(sid, transcript);
    unlinkSync(`/tmp/claude-transcripts-${sid}.chunkstate`);

    await expect(
      fire("SessionStart", sid, transcript, { source: "resume" }, config("http://127.0.0.1:1")),
    ).resolves.toBeUndefined();
    expect(makeChunkState(sid).load().offset).toBe(0);
  });
});

describe("a new transcript still starts from zero", () => {
  for (const source of ["startup", "clear", undefined]) {
    test(`source ${String(source)} resets the offset and does not ask the webapi`, async () => {
      const { sid, transcript } = newSession();
      makeChunkState(sid).save({ offset: 999, lastFlushMs: 1 });
      docs.set(`chunk:${sid}:000000000000`, {
        type: "chunk",
        session_id: sid,
        byte_start: 0,
        byte_end: 999,
      });

      await fire("SessionStart", sid, transcript, source ? { source } : {});
      expect(makeChunkState(sid).load().offset).toBe(0);
      expect(highWaterQueries).toBe(0);
    });
  }
});

describe("fetchChunkHighWater against the fake webapi", () => {
  const chunk = (sid: string, start: number, end: number) =>
    docs.set(`chunk:${sid}:${String(start).padStart(12, "0")}`, {
      type: "chunk",
      session_id: sid,
      byte_start: start,
      byte_end: end,
    });
  const target = () => ({ url: `http://localhost:${server.port}` });

  test("returns how far the session's chunks reach", async () => {
    chunk("abc", 0, 100);
    chunk("abc", 100, 2_500);
    chunk("abc", 2_500, 2_600);
    expect(await fetchChunkHighWater(target(), "abc")).toBe(2_600);
  });

  test("null when the session has no chunks", async () => {
    chunk("other", 0, 100);
    expect(await fetchChunkHighWater(target(), "abc")).toBeNull();
  });

  test("null on an error response", async () => {
    chunk("abc", 0, 100);
    mode = "error";
    expect(await fetchChunkHighWater(target(), "abc")).toBeNull();
  });

  test("null when the webapi does not answer in time", async () => {
    chunk("abc", 0, 100);
    mode = "slow";
    expect(await fetchChunkHighWater(target(), "abc", 50)).toBeNull();
  });
});

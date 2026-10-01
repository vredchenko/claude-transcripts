/**
 * Resuming an ended session must not re-chunk what is already stored (#168). Real
 * handlers against a fake CouchDB: first-write-wins PUT and a key range over `_all_docs`.
 */
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HANDLERS } from "./handlers";
import { buildContext, fetchChunkHighWater, type HookConfig, makeChunkState } from "./runtime";

const DB = "s";
const docs = new Map<string, Record<string, unknown>>();
let allDocsQueries = 0;
let mode: "ok" | "error" | "slow" = "ok";

const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const url = new URL(req.url);
    const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
    if (req.method === "GET" && parts[1] === "_all_docs") {
      allDocsQueries++;
      if (mode === "error") return new Response("boom", { status: 500 });
      if (mode === "slow") await Bun.sleep(500);
      const q = url.searchParams;
      const descending = q.get("descending") === "true";
      const a = JSON.parse(q.get("startkey") ?? '""') as string;
      const b = JSON.parse(q.get("endkey") ?? '"￰"') as string;
      const [lo, hi] = descending ? [b, a] : [a, b];
      const ids = [...docs.keys()].filter((id) => id >= lo && id <= hi).sort();
      if (descending) ids.reverse();
      const limit = Number(q.get("limit") ?? ids.length);
      const rows = ids.slice(0, limit).map((id) => ({
        id,
        key: id,
        ...(q.get("include_docs") === "true" ? { doc: docs.get(id) } : {}),
      }));
      return Response.json({ total_rows: docs.size, offset: 0, rows });
    }
    if (req.method === "PUT" && parts.length === 2) {
      const id = parts[1] as string;
      if (docs.has(id)) return Response.json({ error: "conflict" }, { status: 409 });
      docs.set(id, { ...((await req.json()) as Record<string, unknown>), _id: id });
      return Response.json({ ok: true }, { status: 201 });
    }
    if (req.method === "POST") return Response.json({ ok: true }, { status: 201 });
    return new Response("nope", { status: 405 });
  },
});

const dir = mkdtempSync(join(tmpdir(), "ct-chunk-resume-"));
const sessions: string[] = [];

afterEach(() => {
  docs.clear();
  allDocsQueries = 0;
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
  couch: { url, databases: { sessions: DB } },
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
    // A local offset was there, so the store was never asked.
    expect(allDocsQueries).toBe(0);
    appendEntries(transcript, 3, "resumed");
    await fire("Stop", sid, transcript);

    const size = statSync(transcript).size;
    expectTiles(sid, size);
    expect(ranges(sid).filter(([start]) => start >= ended)).toHaveLength(2);
  });
});

describe("resume with the local chunk state lost (e.g. a reboot)", () => {
  test("seeds the offset from the store's highest byte_end", async () => {
    const { sid, transcript } = newSession();
    const ended = await runAndEnd(sid, transcript);
    unlinkSync(`/tmp/claude-transcripts-${sid}.chunkstate`);

    await fire("SessionStart", sid, transcript, { source: "resume" });
    expect(allDocsQueries).toBe(1);
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

  test("a local offset past the end of the file falls back to the store", async () => {
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

  test("an unreachable store falls back to offset 0 without throwing", async () => {
    const { sid, transcript } = newSession();
    await runAndEnd(sid, transcript);
    unlinkSync(`/tmp/claude-transcripts-${sid}.chunkstate`);

    await expect(
      fire("SessionStart", sid, transcript, { source: "resume" }, config("http://127.0.0.1:1")),
    ).resolves.toBeUndefined();
    expect(makeChunkState(sid).load().offset).toBe(0);
  });

  test("the store is not asked when chunking is off", async () => {
    const { sid, transcript } = newSession();
    const off = { ...config(), features: { midFlightChunking: false } };
    await fire("SessionStart", sid, transcript, { source: "resume" }, off);
    expect(allDocsQueries).toBe(0);
  });
});

describe("a new transcript still starts from zero", () => {
  for (const source of ["startup", "clear", undefined]) {
    test(`source ${String(source)} resets the offset and does not ask the store`, async () => {
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
      expect(allDocsQueries).toBe(0);
    });
  }
});

describe("fetchChunkHighWater", () => {
  const chunk = (sid: string, start: number, end: number) =>
    docs.set(`chunk:${sid}:${String(start).padStart(12, "0")}`, {
      type: "chunk",
      session_id: sid,
      byte_start: start,
      byte_end: end,
    });

  test("returns the byte_end of the highest-starting chunk", async () => {
    chunk("abc", 0, 100);
    chunk("abc", 100, 2_500);
    chunk("abc", 2_500, 2_600);
    expect(await fetchChunkHighWater(config(), DB, "abc")).toBe(2_600);
  });

  test("ignores a session whose id merely shares the prefix", async () => {
    chunk("abc", 0, 100);
    chunk("abcd", 0, 9_999);
    docs.set("summary:abc", { type: "summary", byte_end: 50_000 });
    expect(await fetchChunkHighWater(config(), DB, "abc")).toBe(100);
  });

  test("null when the session has no chunks", async () => {
    chunk("other", 0, 100);
    expect(await fetchChunkHighWater(config(), DB, "abc")).toBeNull();
  });

  test("null on an error response", async () => {
    chunk("abc", 0, 100);
    mode = "error";
    expect(await fetchChunkHighWater(config(), DB, "abc")).toBeNull();
  });

  test("null when the store does not answer in time", async () => {
    chunk("abc", 0, 100);
    mode = "slow";
    expect(await fetchChunkHighWater(config(), DB, "abc", 50)).toBeNull();
  });
});

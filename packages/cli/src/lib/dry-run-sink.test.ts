/**
 * The dry-run sink reads the store it is previewing against.
 *
 * It used to answer every read from nothing — `existingSession` null, `hasTurns` false,
 * `hasTranscriptBlob` true — which meant `planReingest` saw `existing: null` for every
 * session and returned its first branch, `adopt`. The whole decision tree was
 * unreachable under `--dry-run`, so a preview over a corpus of 542 sessions announced
 * 16 adoptions where a real run skipped 15 of them. Reads are GETs; consulting them
 * writes nothing, which is the only promise `--dry-run` makes.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { setWebapiUrl } from "../api/http";
import { DryRunSink } from "./sink";

/** A webapi with one adopted session that has turns and no transcript blob. */
const server = Bun.serve({
  port: 0,
  fetch(req) {
    const { pathname } = new URL(req.url);
    if (pathname === "/api/sessions/adopted") {
      return Response.json({ sessionId: "adopted", source: "live", status: "ended" });
    }
    if (pathname === "/api/sessions/adopted/turns") return Response.json({ turns: [{}] });
    // Its transcript never reached S3 — the state a cancelled SessionEnd leaves.
    if (pathname === "/api/s3/sessions/adopted/transcript.jsonl") {
      return new Response("nope", { status: 404 });
    }
    return new Response("not found", { status: 404 });
  },
});
afterAll(() => server.stop(true));

describe("DryRunSink reads", () => {
  test("an adopted session is reported as adopted, not as new", async () => {
    setWebapiUrl(`http://localhost:${server.port}`);
    const sink = new DryRunSink();
    expect(await sink.existingSession("adopted")).toMatchObject({ status: "ended" });
    expect(await sink.hasTurns("adopted")).toBe(true);
    // The blob really is missing, and the preview can now see it.
    expect(await sink.hasTranscriptBlob("adopted")).toBe(false);
    expect(sink.blind).toBe(false);
  });

  test("a session the store has never seen still reads as new", async () => {
    setWebapiUrl(`http://localhost:${server.port}`);
    const sink = new DryRunSink();
    expect(await sink.existingSession("unknown")).toBeNull();
    // A 404 is an answer, not a failure to reach the store.
    expect(sink.blind).toBe(false);
  });

  test("writes still touch nothing", async () => {
    setWebapiUrl(`http://localhost:${server.port}`);
    const sink = new DryRunSink();
    await expect(sink.putTranscript("adopted", new Uint8Array([1]))).resolves.toBeUndefined();
    await expect(sink.resetSession("adopted")).resolves.toEqual({
      summary: 0,
      events: 0,
      chunks: 0,
    });
  });
});

describe("DryRunSink with an unreachable store", () => {
  test("falls back to 'nothing is stored', but records that it is guessing", async () => {
    setWebapiUrl("http://127.0.0.1:1");
    const sink = new DryRunSink();
    expect(await sink.existingSession("anything")).toBeNull();
    expect(sink.blind).toBe(true);
  });

  test("blind, it claims the blob is present — it must not invent a repair", async () => {
    setWebapiUrl("http://127.0.0.1:1");
    const sink = new DryRunSink();
    // The opposite default would advertise a repair nobody confirmed was needed.
    expect(await sink.hasTranscriptBlob("anything")).toBe(true);
    expect(sink.blind).toBe(true);
  });
});

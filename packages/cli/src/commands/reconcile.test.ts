import { afterEach, describe, expect, test } from "bun:test";
import type { SessionSummary } from "../api/generated";
import { setWebapiUrl } from "../api/http";
import { buildReconciledSummary } from "../lib/session-docs";
import { reconcileOne } from "./reconcile";

const S: SessionSummary = {
  sessionId: "s-1",
  timestamp: "2026-10-20T09:00:00Z",
  lastActivity: "2026-10-20T11:30:00Z",
  model: "claude-opus-5-5",
  cwd: "/p",
  hostname: "h",
  eventCount: 40,
  promptCount: 6,
  errorCount: 2,
  toolCounts: { Bash: 9 },
  endReason: "incomplete",
  hasTranscript: true,
  transcriptSize: 12345,
  status: "incomplete",
  source: "live",
};

const LINE = JSON.stringify({
  type: "assistant",
  message: { id: "m1", usage: { input_tokens: 10, output_tokens: 5 } },
});

describe("buildReconciledSummary", () => {
  test("keeps the recorded counts and ends at the last activity", () => {
    const doc = buildReconciledSummary(S, null, "2026-10-26T12:00:00Z");
    expect(doc).toMatchObject({
      _id: "summary:s-1",
      timestamp: "2026-10-20T11:30:00Z",
      end_reason: "unknown",
      event_count: 40,
      prompt_count: 6,
      error_count: 2,
      tool_counts: { Bash: 9 },
      transcript_bytes: 12345,
      source: "reconcile",
      reconciled_at: "2026-10-26T12:00:00Z",
    });
  });

  test("leaves token usage out without a transcript, and counts it with one", () => {
    expect(buildReconciledSummary(S, null, "t")).not.toHaveProperty("token_usage");
    const doc = buildReconciledSummary(S, `${LINE}\n`, "t");
    expect(doc.token_usage?.total).toBe(15);
    expect(doc.transcript_bytes).toBe(LINE.length + 1);
  });
});

describe("reconcileOne", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });
  const opts = (over: object = {}) => {
    const written: string[] = [];
    return {
      written,
      o: {
        dryRun: false,
        force: false,
        now: "t",
        blobs: true,
        sink: { putSummary: async (d: { _id: string }) => void written.push(d._id) },
        ...over,
      },
    };
  };

  test("skips a session that ended, and a running one unless forced", async () => {
    const { o, written } = opts();
    expect((await reconcileOne({ ...S, status: "ended" }, o)).result).toBe("skipped");
    expect((await reconcileOne({ ...S, status: "running" }, o)).reason).toContain("--force");
    expect(written).toEqual([]);
  });

  test("writes the summary, noting whether the S3 transcript was there", async () => {
    setWebapiUrl("http://webapi.test");
    globalThis.fetch = (async () => new Response("", { status: 404 })) as unknown as typeof fetch;
    const { o, written } = opts();
    expect(await reconcileOne(S, o)).toEqual({
      sessionId: "s-1",
      result: "reconciled",
      tokens: false,
    });
    expect(written).toEqual(["summary:s-1"]);
  });

  test("a store that can't answer fails the session rather than dropping its tokens", async () => {
    setWebapiUrl("http://webapi.test");
    globalThis.fetch = (async () => new Response("", { status: 500 })) as unknown as typeof fetch;
    const { o, written } = opts();
    expect((await reconcileOne(S, o)).result).toBe("failed");
    expect(written).toEqual([]);
  });

  test("with no blob store, it doesn't look", async () => {
    let asked = false;
    globalThis.fetch = (async () => {
      asked = true;
      return new Response("", { status: 500 });
    }) as unknown as typeof fetch;
    const { o } = opts({ blobs: false });
    expect((await reconcileOne(S, o)).result).toBe("reconciled");
    expect(asked).toBe(false);
  });

  test("a dry run writes nothing", async () => {
    setWebapiUrl("http://webapi.test");
    globalThis.fetch = (async () => new Response("", { status: 404 })) as unknown as typeof fetch;
    const { o, written } = opts({ dryRun: true });
    expect((await reconcileOne(S, o)).result).toBe("would-reconcile");
    expect(written).toEqual([]);
  });
});

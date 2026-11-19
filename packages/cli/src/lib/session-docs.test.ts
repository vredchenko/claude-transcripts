import { describe, expect, test } from "bun:test";
import { ChunkDocSchema, EventDocSchema, SummaryDocSchema } from "@claude-transcripts/shared/docs";
import type { SessionSummary } from "../api/generated";
import {
  buildChunkDocs,
  buildEventDocs,
  buildReconciledSummary,
  buildSummaryDoc,
} from "./session-docs";
import { deriveSessionFacts } from "./transcript";

// The writer and the gateway agree: every doc this CLI builds is one `/api/ingest/*`
// accepts, and comes back out of the validator unchanged.

const jsonl = `${[
  JSON.stringify({
    type: "user",
    sessionId: "s-1",
    cwd: "/p",
    timestamp: "2026-10-20T09:00:00Z",
    message: { content: [{ type: "text", text: "run it" }] },
  }),
  JSON.stringify({
    type: "assistant",
    sessionId: "s-1",
    cwd: "/p",
    timestamp: "2026-10-20T09:00:05Z",
    message: {
      model: "claude-opus-5-5",
      usage: { input_tokens: 10, output_tokens: 5 },
      content: [
        { type: "text", text: "ok" },
        { type: "tool_use", name: "Bash", id: "tu_1", input: { command: "ls" } },
        { type: "tool_use", name: "Read", id: "tu_2", input: { path: "x" } },
      ],
    },
  }),
  JSON.stringify({
    type: "user",
    sessionId: "s-1",
    cwd: "/p",
    timestamp: "2026-10-20T09:00:06Z",
    message: {
      content: [
        { type: "tool_result", tool_use_id: "tu_1", content: "a\nb" },
        { type: "tool_result", tool_use_id: "tu_2", is_error: true, content: "nope" },
      ],
    },
  }),
  JSON.stringify({ type: "attachment", attachment: { type: "hook_success" } }),
].join("\n")}\n`;

const facts = deriveSessionFacts(jsonl, { hostname: "h" });

describe("session docs validate against the shared schemas", () => {
  test("buildSummaryDoc", () => {
    for (const doc of [
      buildSummaryDoc(facts, "backfill", { actor: "me", backfilledAt: "2026-11-01T00:00:00Z" }),
      buildSummaryDoc(facts, "doctor"),
    ]) {
      expect(SummaryDocSchema.parse(doc)).toEqual(doc);
    }
  });

  test("buildReconciledSummary, with and without a transcript", () => {
    const s: SessionSummary = {
      sessionId: "s-1",
      timestamp: "2026-10-20T09:00:00Z",
      lastActivity: "2026-10-20T09:00:06Z",
      cwd: "/p",
      hostname: "h",
      eventCount: 4,
      promptCount: 1,
      errorCount: 1,
      toolCounts: { Bash: 1, Read: 1 },
      endReason: "incomplete",
      hasTranscript: true,
      transcriptSize: jsonl.length,
      status: "incomplete",
      source: "live",
    };
    for (const transcript of [jsonl, null]) {
      const doc = buildReconciledSummary(s, transcript, "2026-11-01T00:00:00Z");
      expect(SummaryDocSchema.parse(doc)).toEqual(doc);
    }
  });

  test("buildChunkDocs, full-content and byte-range-only", () => {
    for (const withContent of [true, false]) {
      const docs = buildChunkDocs(jsonl, facts, "backfill", 2, withContent);
      expect(docs.length).toBeGreaterThan(1);
      for (const doc of docs) expect(ChunkDocSchema.parse(doc)).toEqual(doc);
    }
  });

  test("buildEventDocs", () => {
    const docs = buildEventDocs(jsonl, facts, "backfill");
    expect(docs.map((d) => d.event)).toEqual([
      "SessionStart",
      "UserPromptSubmit",
      "PostToolUse",
      "PostToolUseFailure",
    ]);
    for (const doc of docs) expect(EventDocSchema.parse(doc)).toEqual(doc);
  });
});

describe("buildEventDocs reconstructs model switches and cwd changes (#296)", () => {
  const line = (o: Record<string, unknown>) => JSON.stringify({ sessionId: "s-2", ...o });
  const answer = (ts: string, model: string, extra: Record<string, unknown> = {}) =>
    line({
      type: "assistant",
      cwd: "/p",
      timestamp: ts,
      message: { model, content: [{ type: "text", text: "ok" }] },
      ...extra,
    });
  const transcript = `${[
    line({ type: "system", cwd: "/elsewhere", timestamp: "2026-10-20T08:59:59Z" }),
    line({
      type: "user",
      cwd: "/p",
      timestamp: "2026-10-20T09:00:00Z",
      message: { content: [{ type: "text", text: "go" }] },
    }),
    answer("2026-10-20T09:00:01Z", "m-opus"),
    // A subagent on another model, and a turn Claude Code made up itself: neither is a switch.
    answer("2026-10-20T09:00:02Z", "m-haiku", { isSidechain: true, cwd: "/sub" }),
    answer("2026-10-20T09:00:03Z", "<synthetic>"),
    answer("2026-10-20T09:00:04Z", "m-sonnet", { cwd: "/p/src" }),
    answer("2026-10-20T09:00:05Z", "m-sonnet", { cwd: "/p/src" }),
  ].join("\n")}\n`;
  const f = deriveSessionFacts(transcript, { hostname: "h" });
  const docs = buildEventDocs(transcript, f, "backfill");
  const of = (event: string) => docs.filter((d) => d.event === event);

  test("the session's model is the first real main-chain one", () => {
    expect(f.model).toBe("m-opus");
  });

  test("one PostModelSwitch, where the main chain's model changes", () => {
    expect(of("PostModelSwitch")).toEqual([
      expect.objectContaining({
        timestamp: "2026-10-20T09:00:04Z",
        from_model: "m-opus",
        to_model: "m-sonnet",
        reconstructed: true,
      }),
    ]);
  });

  test("one CwdChanged, and later markers carry the new cwd", () => {
    expect(of("CwdChanged")).toEqual([
      expect.objectContaining({ old_cwd: "/p", new_cwd: "/p/src", cwd: "/p/src" }),
    ]);
    expect(of("SessionStart")[0]?.cwd).toBe("/p");
  });

  test("the reconstructed markers validate", () => {
    for (const d of docs) expect(EventDocSchema.parse(d)).toEqual(d);
  });
});

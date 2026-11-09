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

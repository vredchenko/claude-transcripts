import { describe, expect, test } from "bun:test";
import {
  buildChunkEntries,
  type ChunkEntry,
  chunkDocId,
  sliceIntoChunks,
  sumTranscriptTokens,
} from "../index";
import {
  type ChunkDoc,
  ChunkDocSchema,
  type ChunkEntryDoc,
  type EventDoc,
  EventDocSchema,
  type SummaryDoc,
  SummaryDocSchema,
} from "./index";

const jsonl = [
  JSON.stringify({
    type: "user",
    timestamp: "t1",
    message: { content: [{ type: "text", text: "hello" }] },
  }),
  JSON.stringify({
    type: "assistant",
    timestamp: "t2",
    message: {
      usage: { input_tokens: 10, output_tokens: 5 },
      content: [
        { type: "text", text: "hi" },
        { type: "tool_use", name: "Bash", id: "tu_1" },
      ],
    },
  }),
  JSON.stringify({
    type: "user",
    timestamp: "t3",
    isSidechain: true,
    message: {
      content: [{ type: "tool_result", tool_use_id: "tu_1", is_error: true, content: "boom" }],
    },
  }),
  JSON.stringify({ type: "attachment", attachment: { type: "hook_success" } }),
  "{ not valid json",
].join("\n");

// Compile-time: every entry the projector builds is one the validator's type admits.
const fits = (e: ChunkEntry): ChunkEntryDoc => e;

describe("ChunkDocSchema", () => {
  test("accepts the chunk docs the shared chunking + projection helpers build", () => {
    const entries = buildChunkEntries(jsonl);
    let cursor = 0;
    const docs: ChunkDoc[] = sliceIntoChunks(jsonl, 2).map((s) => {
      const slice = entries.slice(cursor, cursor + s.entryCount).map(fits);
      cursor += s.entryCount;
      return {
        _id: chunkDocId("s-1", s.byteStart),
        type: "chunk",
        session_id: "s-1",
        byte_start: s.byteStart,
        byte_end: s.byteEnd,
        entry_count: s.entryCount,
        timestamp: "t1",
        hostname: "h",
        cwd: "/p",
        schema_version: 2,
        source: "backfill",
        entries: slice,
      };
    });
    expect(docs.length).toBeGreaterThan(1);
    for (const doc of docs) expect(ChunkDocSchema.parse(doc)).toEqual(doc);
  });

  test("rejects an entry with an unknown role", () => {
    const bad = {
      _id: "chunk:s-1:0",
      type: "chunk",
      session_id: "s-1",
      byte_start: 0,
      byte_end: 1,
      entry_count: 1,
      timestamp: "t",
      hostname: "h",
      cwd: "/p",
      schema_version: 2,
      entries: [{ role: "narrator" }],
    };
    expect(ChunkDocSchema.safeParse(bad).success).toBe(false);
  });
});

describe("SummaryDocSchema", () => {
  const doc: SummaryDoc = {
    _id: "summary:s-1",
    type: "summary",
    event: "SessionEnd",
    session_id: "s-1",
    timestamp: "t3",
    hostname: "h",
    cwd: "/p",
    end_reason: "unknown",
    event_count: 3,
    prompt_count: 1,
    error_count: 1,
    tool_counts: { Bash: 1 },
    transcript_bytes: jsonl.length,
    token_usage: sumTranscriptTokens(jsonl),
    source: "reconcile",
    reconciled_at: "t9",
  };

  test("round-trips, keeping fields beyond the listed ones (passthrough)", () => {
    expect(SummaryDocSchema.parse(doc)).toEqual(doc);
  });

  test("rejects a doc missing a required field or with the wrong type tag", () => {
    const { end_reason: _, ...missing } = doc;
    expect(SummaryDocSchema.safeParse(missing).success).toBe(false);
    expect(SummaryDocSchema.safeParse({ ...doc, type: "event" }).success).toBe(false);
  });
});

describe("EventDocSchema", () => {
  test("keeps per-event marker fields", () => {
    const doc: EventDoc = {
      type: "event",
      event: "PostToolUse",
      session_id: "s-1",
      timestamp: "t2",
      hostname: "h",
      cwd: "/p",
      tool_name: "Bash",
      reconstructed: true,
    };
    expect(EventDocSchema.parse(doc)).toEqual(doc);
    expect(EventDocSchema.safeParse({ ...doc, session_id: 1 }).success).toBe(false);
  });
});

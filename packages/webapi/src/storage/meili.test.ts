import { describe, expect, it } from "bun:test";
import { searchDocId, toSessionSearchDoc, toTurnSearchDocs } from "./meili";

/**
 * Meilisearch document ids accept only `a-zA-Z0-9`, `-` and `_`, and it enforces that
 * **asynchronously** — an illegal id fails the whole batch with `invalid_document_id`
 * long after the POST returned `202`, so the write path can't see it. That's how the
 * turns index sat empty while thousands of documents were "accepted": ids were built
 * as `<session>:<byteStart>:<index>`. These tests pin the constraint.
 */
const MEILI_ID = /^[a-zA-Z0-9_-]+$/;

const chunk = {
  type: "chunk",
  session_id: "864b2c31-8b61-4197-a166-8768da3097a2",
  byte_start: 13585,
  timestamp: "2026-07-29T00:58:59.000Z",
  cwd: "/home/u/dev/proj",
  entries: [
    { role: "user", text: "hello", timestamp: "2026-07-29T00:59:00.000Z" },
    { role: "assistant", toolUses: [{ name: "Bash" }] }, // no text → skipped
    { role: "assistant", text: "hi back", timestamp: "2026-07-29T00:59:01.000Z" },
  ],
};

describe("searchDocId", () => {
  it("emits only characters Meilisearch accepts", () => {
    expect(searchDocId("a:b", 1, 2)).toMatch(MEILI_ID);
    expect(searchDocId("sess/id with spaces", 0)).toMatch(MEILI_ID);
  });

  it("is stable for the same parts (re-ingest replaces, never duplicates)", () => {
    expect(searchDocId("s", 10, 3)).toBe(searchDocId("s", 10, 3));
  });

  it("keeps already-legal ids intact — a UUID must survive unchanged", () => {
    const uuid = "864b2c31-8b61-4197-a166-8768da3097a2";
    expect(searchDocId(uuid)).toBe(uuid);
  });
});

describe("toTurnSearchDocs", () => {
  it("gives every turn a legal, distinct id", () => {
    const docs = toTurnSearchDocs(chunk);
    expect(docs.length).toBe(2); // the text-less turn is skipped
    for (const d of docs) expect(String(d.id)).toMatch(MEILI_ID);
    expect(new Set(docs.map((d) => d.id)).size).toBe(docs.length);
  });

  it("carries the fields the search route reads", () => {
    const first = toTurnSearchDocs(chunk)[0];
    expect(first?.sessionId).toBe(chunk.session_id);
    expect(first?.role).toBe("user");
    expect(first?.text).toBe("hello");
    expect(first?.cwd).toBe(chunk.cwd);
    expect(first?.timestamp).toBe("2026-07-29T00:59:00.000Z");
  });

  it("indexes nothing for a byte-range-only chunk", () => {
    expect(toTurnSearchDocs({ ...chunk, entries: undefined })).toEqual([]);
  });
});

describe("toSessionSearchDoc", () => {
  it("gives the session a legal id", () => {
    const doc = toSessionSearchDoc({ session_id: chunk.session_id, tool_counts: { Bash: 2 } });
    expect(String(doc.id)).toMatch(MEILI_ID);
    expect(doc.tools).toEqual(["Bash"]);
  });
});

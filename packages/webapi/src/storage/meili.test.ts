import { describe, expect, it } from "bun:test";
import { Meili, searchDocId, toSessionSearchDoc, toTurnSearchDocs } from "./meili";

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

describe("Meili.pruneTasks", () => {
  it("deletes only finished, old tasks on the given indexes", async () => {
    const calls: { method: string; url: string }[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      calls.push({ method: String(init.method), url: String(url) });
      return new Response(JSON.stringify({ taskUid: 7 }), { status: 202 });
    }) as unknown as typeof fetch;
    try {
      const meili = new Meili({ host: "http://meili.test", enabled: true });
      expect(await meili.pruneTasks(["a-sessions", "a-turns"], 60_000)).toBe(7);
    } finally {
      globalThis.fetch = realFetch;
    }

    expect(calls.length).toBe(1);
    const [call] = calls;
    expect(call?.method).toBe("DELETE");
    const params = new URL(call?.url ?? "").searchParams;
    // A shared Meilisearch holds other deployments' tasks — never prune unscoped.
    expect(params.get("indexUids")).toBe("a-sessions,a-turns");
    expect(params.get("statuses")).toBe("succeeded,failed,canceled");
    expect(Date.parse(params.get("beforeFinishedAt") ?? "")).toBeLessThan(Date.now() - 59_000);
  });

  it("returns null, not a throw, when Meilisearch rejects the request", async () => {
    // A wrong parameter name comes back as a 400. Pruning is best-effort, so that
    // must surface as null rather than an exception the follower would have to catch.
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ message: "Unknown parameter `status`" }), {
        status: 400,
      })) as unknown as typeof fetch;
    try {
      const meili = new Meili({ host: "http://meili.test", enabled: true });
      expect(await meili.pruneTasks(["a-sessions"], 60_000)).toBeNull();
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

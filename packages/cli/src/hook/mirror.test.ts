/**
 * Mirror targets.
 *
 * A mirror is the one writer that can't use the hook's normal path — a remote
 * instance's CouchDB and S3 aren't reachable, so writes have to be translated onto its
 * `/api/ingest` surface. These pin that translation, and the two properties the hook
 * depends on: a mirror never throws, and a mirror never stops the primary.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { fanOutBlob, fanOutCouch, makeMirrorBlob, makeMirrorCouch } from "./mirror";
import type { BlobClient, CouchClient } from "./runtime";

const REAL_FETCH = globalThis.fetch;

interface Seen {
  url: string;
  method: string;
  body: string;
  headers: Record<string, string>;
}

let seen: Seen[];

/** Record every request instead of making one. `fail` makes the target unreachable. */
function stubFetch(fail = false): void {
  globalThis.fetch = (async (input: any, init: any) => {
    if (fail) throw new Error("ECONNREFUSED");
    seen.push({
      url: String(input),
      method: init?.method ?? "GET",
      body: typeof init?.body === "string" ? init.body : String(init?.body ?? ""),
      headers: (init?.headers ?? {}) as Record<string, string>,
    });
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
}

beforeEach(() => {
  seen = [];
  stubFetch();
});

afterEach(() => {
  globalThis.fetch = REAL_FETCH;
});

const TARGET = { url: "https://logs.example.com" };

describe("makeMirrorCouch", () => {
  test("posts an event doc to the events endpoint, wrapped in `docs`", async () => {
    await makeMirrorCouch(TARGET).postDoc("ignored-db", { type: "event", session_id: "s1" });

    expect(seen).toHaveLength(1);
    expect(seen[0]?.url).toBe("https://logs.example.com/api/ingest/events");
    expect(seen[0]?.method).toBe("POST");
    expect(JSON.parse(seen[0]?.body ?? "{}")).toEqual({
      docs: [{ type: "event", session_id: "s1" }],
    });
  });

  test("moves the id into the body for a chunk — that is what stops a re-flush duplicating", async () => {
    await makeMirrorCouch(TARGET).putDoc("ignored-db", "chunk:s1:0", {
      type: "chunk",
      session_id: "s1",
    });

    expect(seen[0]?.url).toBe("https://logs.example.com/api/ingest/chunks");
    const body = JSON.parse(seen[0]?.body ?? "{}");
    expect(body.docs[0]._id).toBe("chunk:s1:0");
  });

  test("the caller's id wins over one already on the doc", async () => {
    await makeMirrorCouch(TARGET).putDoc("db", "chunk:s1:64", {
      type: "chunk",
      _id: "stale",
    });

    expect(JSON.parse(seen[0]?.body ?? "{}").docs[0]._id).toBe("chunk:s1:64");
  });

  test("sends a summary as a bare doc, not wrapped", async () => {
    await makeMirrorCouch(TARGET).putDoc("db", "summary:s1", { type: "summary", session_id: "s1" });

    expect(seen[0]?.url).toBe("https://logs.example.com/api/ingest/summary");
    const body = JSON.parse(seen[0]?.body ?? "{}");
    expect(body.docs).toBeUndefined();
    expect(body._id).toBe("summary:s1");
  });

  test("skips a doc kind ingest has no endpoint for rather than guessing", async () => {
    await makeMirrorCouch(TARGET).postDoc("db", { type: "something-new" });
    expect(seen).toHaveLength(0);
  });

  test("normalises a trailing slash on the target url", async () => {
    await makeMirrorCouch({ url: "https://logs.example.com/" }).postDoc("db", { type: "event" });
    expect(seen[0]?.url).toBe("https://logs.example.com/api/ingest/events");
  });

  test("sends basic auth only when configured", async () => {
    await makeMirrorCouch({ ...TARGET, auth: "u:p" }).postDoc("db", { type: "event" });
    expect(seen[0]?.headers.Authorization).toBe(`Basic ${btoa("u:p")}`);

    seen = [];
    await makeMirrorCouch(TARGET).postDoc("db", { type: "event" });
    expect(seen[0]?.headers.Authorization).toBeUndefined();
  });

  test("swallows an unreachable target — a mirror must never block a session", async () => {
    stubFetch(true);
    const couch = makeMirrorCouch(TARGET);
    await expect(couch.postDoc("db", { type: "event" })).resolves.toBeUndefined();
    await expect(couch.putDoc("db", "summary:s1", { type: "summary" })).resolves.toBeUndefined();
  });
});

describe("makeMirrorBlob", () => {
  test("puts a transcript to the session's ingest endpoint", async () => {
    await makeMirrorBlob(TARGET).put(
      "bucket",
      "s1/transcript.jsonl",
      "{}\n",
      "application/x-ndjson",
    );

    expect(seen[0]?.url).toBe("https://logs.example.com/api/ingest/s1/transcript");
    expect(seen[0]?.method).toBe("PUT");
    expect(seen[0]?.body).toBe("{}\n");
  });

  test("skips summary.json — ingest has no endpoint, and the doc is mirrored anyway", async () => {
    await makeMirrorBlob(TARGET).put("bucket", "s1/summary.json", "{}", "application/json");
    expect(seen).toHaveLength(0);
  });

  test("swallows an unreachable target", async () => {
    stubFetch(true);
    await expect(
      makeMirrorBlob(TARGET).put("b", "s1/transcript.jsonl", "x", "application/x-ndjson"),
    ).resolves.toBeUndefined();
  });
});

/** A CouchClient that records calls, and optionally rejects. */
function recordingCouch(log: string[], name: string, reject = false): CouchClient {
  const note = async (what: string): Promise<void> => {
    log.push(`${name}:${what}`);
    if (reject) throw new Error("down");
  };
  return {
    postDoc: (_db, _doc) => note("post"),
    putDoc: (_db, id) => note(`put:${id}`),
  };
}

describe("fanOutCouch", () => {
  test("writes to every target", async () => {
    const log: string[] = [];
    await fanOutCouch([recordingCouch(log, "a"), recordingCouch(log, "b")]).postDoc("db", {});
    expect(log.sort()).toEqual(["a:post", "b:post"]);
  });

  test("one target failing does not skip the others, and does not throw", async () => {
    const log: string[] = [];
    const fan = fanOutCouch([recordingCouch(log, "a", true), recordingCouch(log, "b")]);
    await expect(fan.putDoc("db", "summary:s1", {})).resolves.toBeUndefined();
    expect(log.sort()).toEqual(["a:put:summary:s1", "b:put:summary:s1"]);
  });

  test("a lone client is passed through untouched", () => {
    const only = recordingCouch([], "a");
    expect(fanOutCouch([only])).toBe(only);
  });
});

/** A BlobClient that records calls. */
function recordingBlob(log: string[], name: string, enabled = true): BlobClient {
  return {
    enabled,
    put: async () => {
      log.push(name);
    },
  };
}

describe("fanOutBlob", () => {
  test("writes to every enabled target and ignores disabled ones", async () => {
    const log: string[] = [];
    const fan = fanOutBlob([
      recordingBlob(log, "local", false),
      recordingBlob(log, "mirror"),
      recordingBlob(log, "mirror2"),
    ]);
    await fan.put("b", "s1/transcript.jsonl", "x", "application/x-ndjson");
    expect(log.sort()).toEqual(["mirror", "mirror2"]);
  });

  test("stays enabled when only a mirror can take blobs", () => {
    const fan = fanOutBlob([recordingBlob([], "local", false), recordingBlob([], "mirror")]);
    expect(fan.enabled).toBe(true);
  });

  test("is disabled when nothing can take a blob", () => {
    expect(fanOutBlob([recordingBlob([], "local", false)]).enabled).toBe(false);
  });
});

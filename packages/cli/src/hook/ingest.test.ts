/**
 * The hook's write path: a webapi's `/api/ingest` surface (#288).
 *
 * These pin the translation onto ingest routes, and the properties the hook depends
 * on: a write never throws, one target never stops another, and every outcome — with
 * its reason — is reported, because nothing else will say a write was lost.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  fanOut,
  fetchChunkHighWater,
  type IngestClient,
  makeIngestClient,
  probeWebapi,
  type WriteOutcome,
} from "./ingest";

const REAL_FETCH = globalThis.fetch;

interface Seen {
  url: string;
  method: string;
  body: string;
  headers: Record<string, string>;
}

let seen: Seen[];

/** Record every request instead of making one; answer with `respond`'s response. */
function stubFetch(respond: () => Response | Promise<Response> = () => new Response("{}")): void {
  globalThis.fetch = (async (input: any, init: any) => {
    seen.push({
      url: String(input),
      method: init?.method ?? "GET",
      body: typeof init?.body === "string" ? init.body : String(init?.body ?? ""),
      headers: (init?.headers ?? {}) as Record<string, string>,
    });
    return respond();
  }) as typeof fetch;
}

const refuse = () => {
  throw new Error("ECONNREFUSED");
};

beforeEach(() => {
  seen = [];
  stubFetch();
});

afterEach(() => {
  globalThis.fetch = REAL_FETCH;
});

const TARGET = { url: "https://logs.example.com/" };

describe("makeIngestClient routes", () => {
  test("an event is posted to /api/ingest/events as a one-doc batch", async () => {
    await makeIngestClient(TARGET).event({ type: "event", session_id: "s1" });
    expect(seen[0]?.url).toBe("https://logs.example.com/api/ingest/events");
    expect(seen[0]?.method).toBe("POST");
    expect(JSON.parse(seen[0]?.body ?? "")).toEqual({
      docs: [{ type: "event", session_id: "s1" }],
    });
  });

  test("a chunk keeps its deterministic _id, so a re-flush is a benign conflict", async () => {
    await makeIngestClient(TARGET).chunk({ _id: "chunk:s1:0", type: "chunk" });
    expect(seen[0]?.url).toBe("https://logs.example.com/api/ingest/chunks");
    expect(JSON.parse(seen[0]?.body ?? "").docs[0]._id).toBe("chunk:s1:0");
  });

  test("a summary goes to the upserting summary route, id and all", async () => {
    await makeIngestClient(TARGET).summary({ _id: "summary:s1", type: "summary" });
    expect(seen[0]?.url).toBe("https://logs.example.com/api/ingest/summary");
    expect(JSON.parse(seen[0]?.body ?? "")._id).toBe("summary:s1");
  });

  test("the transcript is PUT raw, as NDJSON, under the session id", async () => {
    await makeIngestClient(TARGET).transcript("s/1", '{"a":1}\n');
    expect(seen[0]?.url).toBe("https://logs.example.com/api/ingest/s%2F1/transcript");
    expect(seen[0]?.method).toBe("PUT");
    expect(seen[0]?.headers["Content-Type"]).toBe("application/x-ndjson");
    expect(seen[0]?.body).toBe('{"a":1}\n');
  });

  test("basic auth travels as a header, never in the URL", async () => {
    await makeIngestClient({ ...TARGET, auth: "u:p" }).event({ type: "event" });
    expect(seen[0]?.headers.Authorization).toBe(`Basic ${btoa("u:p")}`);
    expect(seen[0]?.url).not.toContain("u:p");
  });
});

describe("makeIngestClient outcomes — every write says how it went", () => {
  const outcomes = async (respond: () => Response | Promise<Response>) => {
    stubFetch(respond);
    const got: WriteOutcome[] = [];
    await makeIngestClient(TARGET, (o) => got.push(o)).event({ type: "event" });
    return got;
  };

  test("a landed write reports success", async () => {
    expect(await outcomes(() => new Response("{}"))).toEqual([{ ok: true }]);
  });

  test("a rejected write reports the status", async () => {
    expect(await outcomes(() => new Response("{}", { status: 503 }))).toEqual([
      { ok: false, reason: "HTTP 503" },
    ]);
  });

  test("an unreachable webapi reports failure instead of throwing", async () => {
    expect(await outcomes(refuse)).toEqual([{ ok: false, reason: "unreachable" }]);
  });

  test("a timeout is named as one", async () => {
    const got = await outcomes(() => {
      throw Object.assign(new Error("t"), { name: "TimeoutError" });
    });
    expect(got).toEqual([{ ok: false, reason: "timeout" }]);
  });

  test("a failed transcript upload is reported too — no more silent S3 path", async () => {
    stubFetch(refuse);
    const got: WriteOutcome[] = [];
    await makeIngestClient(TARGET, (o) => got.push(o)).transcript("s1", "x");
    expect(got).toEqual([{ ok: false, reason: "unreachable" }]);
  });
});

/** An IngestClient that records calls, and optionally rejects. */
function recording(log: string[], name: string, reject = false): IngestClient {
  const note = async (what: string): Promise<void> => {
    log.push(`${name}:${what}`);
    if (reject) throw new Error("down");
  };
  return {
    event: () => note("event"),
    chunk: (doc) => note(`chunk:${doc._id}`),
    summary: (doc) => note(`summary:${doc._id}`),
    transcript: (id) => note(`transcript:${id}`),
  };
}

describe("fanOut", () => {
  test("one target failing does not skip the others, and does not throw", async () => {
    const log: string[] = [];
    const fan = fanOut([recording(log, "a", true), recording(log, "b")]);
    await expect(fan.summary({ _id: "summary:s1" })).resolves.toBeUndefined();
    expect(log.sort()).toEqual(["a:summary:summary:s1", "b:summary:summary:s1"]);
  });

  test("every kind reaches every target, transcripts included", async () => {
    const log: string[] = [];
    const fan = fanOut([recording(log, "a"), recording(log, "b")]);
    await fan.transcript("s1", "x");
    await fan.chunk({ _id: "chunk:s1:0" });
    expect(log.sort()).toEqual([
      "a:chunk:chunk:s1:0",
      "a:transcript:s1",
      "b:chunk:chunk:s1:0",
      "b:transcript:s1",
    ]);
  });

  test("a single target is used as is", () => {
    const only = recording([], "a");
    expect(fanOut([only])).toBe(only);
  });
});

describe("probeWebapi", () => {
  test("a healthy webapi is ok", async () => {
    stubFetch(() => Response.json({ ok: true }));
    expect(await probeWebapi(TARGET)).toEqual({ ok: true });
    expect(seen[0]?.url).toBe("https://logs.example.com/health");
  });

  test("a webapi whose stores are down is not — every ingest write would fail", async () => {
    stubFetch(() => Response.json({ ok: false, status: "degraded" }));
    expect(await probeWebapi(TARGET)).toEqual({ ok: false, reason: "stores unavailable" });
  });

  test("an unreachable webapi says so", async () => {
    stubFetch(refuse);
    expect(await probeWebapi(TARGET)).toEqual({ ok: false, reason: "unreachable" });
  });
});

describe("fetchChunkHighWater", () => {
  test("asks the ingest high-water route and returns its reach", async () => {
    stubFetch(() => Response.json({ id: "s1", bytes: 4096 }));
    expect(await fetchChunkHighWater(TARGET, "s1")).toBe(4096);
    expect(seen[0]?.url).toBe("https://logs.example.com/api/ingest/s1/high-water");
  });

  test("no chunks, an error, or no answer is null — the resume starts fresh", async () => {
    stubFetch(() => Response.json({ id: "s1", bytes: 0 }));
    expect(await fetchChunkHighWater(TARGET, "s1")).toBeNull();
    stubFetch(() => new Response("{}", { status: 500 }));
    expect(await fetchChunkHighWater(TARGET, "s1")).toBeNull();
    stubFetch(refuse);
    expect(await fetchChunkHighWater(TARGET, "s1")).toBeNull();
  });
});

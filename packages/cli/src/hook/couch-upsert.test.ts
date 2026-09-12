/**
 * The summary write, against a CouchDB that behaves like CouchDB.
 *
 * The bug these cover shipped because nothing exercised a *second* write to the same
 * document id. `putDoc` PUTs without a `_rev`, which CouchDB answers with 409 on an id
 * that already exists — and the result was passed to `onWrite` and otherwise dropped,
 * so not writing was indistinguishable from writing. A resumed session's second
 * SessionEnd hit that every time: the CouchDB summary stayed on the first exit's
 * numbers while the S3 copy, a plain overwriting put, moved on. The two stores then
 * disagreed permanently about the same session.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { type HookConfig, makeCouch } from "./runtime";

/** A CouchDB just real enough: PUT without `_rev` onto an existing id is a 409. */
const store = new Map<string, Record<string, unknown>>();
const puts: string[] = [];

const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const id = decodeURIComponent(new URL(req.url).pathname.split("/").pop() ?? "");
    if (req.method === "GET") {
      const doc = store.get(id);
      return doc ? Response.json(doc) : new Response("missing", { status: 404 });
    }
    if (req.method === "PUT") {
      const body = (await req.json()) as Record<string, unknown>;
      puts.push(String(body._rev ?? "no-rev"));
      const current = store.get(id);
      if (current && body._rev !== current._rev) {
        return Response.json({ error: "conflict" }, { status: 409 });
      }
      const rev = `${(current ? Number(String(current._rev).split("-")[0]) : 0) + 1}-x`;
      store.set(id, { ...body, _id: id, _rev: rev });
      return Response.json({ ok: true, rev }, { status: 201 });
    }
    return new Response("nope", { status: 405 });
  },
});
afterAll(() => server.stop(true));

const config = (): HookConfig => ({
  couch: { url: `http://localhost:${server.port}`, databases: { sessions: "s" } },
  features: {},
  system: { logging: { chunk: { maxEntriesPerChunk: 10, flushIntervalMs: 100 } } },
});

function fresh() {
  store.clear();
  puts.length = 0;
}

describe("upsertDoc", () => {
  test("a first write lands, as a plain PUT", async () => {
    fresh();
    const ok: boolean[] = [];
    await makeCouch(config(), (o) => ok.push(o)).upsertDoc("s", "summary:a", { event_count: 1 });
    expect(store.get("summary:a")?.event_count).toBe(1);
    expect(ok).toEqual([true]);
    expect(puts).toEqual(["no-rev"]);
  });

  test("a second write REPLACES the first instead of conflicting away", async () => {
    fresh();
    const couch = makeCouch(config());
    await couch.upsertDoc("s", "summary:a", { event_count: 354 });
    await couch.upsertDoc("s", "summary:a", { event_count: 371 });
    // The bug: this used to still read 354, forever.
    expect(store.get("summary:a")?.event_count).toBe(371);
    // Bare PUT, 409, then a retry carrying the rev it just read.
    expect(puts).toEqual(["no-rev", "no-rev", "1-x"]);
  });

  test("the replacement is reported as a write that landed", async () => {
    fresh();
    const ok: boolean[] = [];
    const couch = makeCouch(config(), (o) => ok.push(o));
    await couch.upsertDoc("s", "summary:a", { n: 1 });
    await couch.upsertDoc("s", "summary:a", { n: 2 });
    // A silent false here is what let the statusline call a stalled store healthy.
    expect(ok).toEqual([true, true]);
  });

  test("putDoc stays first-write-wins — chunk ids are byte offsets, not versions", async () => {
    fresh();
    const couch = makeCouch(config());
    await couch.putDoc("s", "chunk:a:0", { entries: "original" });
    await couch.putDoc("s", "chunk:a:0", { entries: "reflushed" });
    // Re-flushing the same byte span must not rewrite what is stored.
    expect(store.get("chunk:a:0")?.entries).toBe("original");
  });

  test("an unreachable store fails soft — a hook never blocks a session", async () => {
    fresh();
    const ok: boolean[] = [];
    const dead: HookConfig = { ...config(), couch: { url: "http://127.0.0.1:1", databases: {} } };
    await expect(
      makeCouch(dead, (o) => ok.push(o)).upsertDoc("s", "summary:a", {}),
    ).resolves.toBeUndefined();
    expect(ok).toEqual([false]);
  });
});

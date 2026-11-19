/**
 * Per-target write health.
 *
 * A single outcome pair could not express "the instance is down but the mirror is fine",
 * which is the ordinary state of a machine reporting into a shared instance. Collapsed,
 * the indicator was wrong whichever way it resolved.
 */
import { describe, expect, test } from "bun:test";
import { type HookConfig, makeTargets, resolveTargets } from "./runtime";

const WITH_MIRROR = {
  webapi: { url: "http://user:pw@ct.example:7650" },
  features: {},
  mirrors: [{ url: "https://logs.example.com" }],
} as unknown as HookConfig;

describe("resolveTargets stores", () => {
  test("the instance's webapi first, then mirrors in config order", () => {
    const t = resolveTargets(WITH_MIRROR);
    expect(t.stores?.map((s) => s.kind)).toEqual(["webapi", "mirror"]);
    expect(t.stores?.[0]?.label).toBe("ct.example:7650");
    expect(t.stores?.[1]?.label).toBe("logs.example.com");
  });

  test("credentials never reach the targets file — the statusline prints it", () => {
    const t = resolveTargets(WITH_MIRROR);
    expect(JSON.stringify(t)).not.toContain("pw");
    expect(t.webapiUrl).toBe("http://ct.example:7650");
  });

  test("names no store: the hook has no CouchDB or S3 target any more (#288)", () => {
    const t = resolveTargets(WITH_MIRROR);
    expect(t.couchUrl).toBeUndefined();
    expect(t.bucket).toBeUndefined();
  });

  test("always seeds at least the instance — an empty `stores` cannot arise here", () => {
    // A renderer has to decide what an empty array means, and the honest answer is
    // "we never produce one": a loadable config always has a webapi.
    const noMirrors = { webapi: { url: "http://c:7650" }, features: {} } as unknown as HookConfig;
    expect(resolveTargets(noMirrors).stores).toHaveLength(1);
    expect(resolveTargets(noMirrors).stores?.[0]?.kind).toBe("webapi");
  });
});

describe("markWrite", () => {
  test("a mirror's success does not mark the direct store healthy", () => {
    // The reason this is per-store at all. Collapsed into one pair, a healthy mirror
    // would render a confident "recording" labelled with the dead primary's host.
    const store = makeTargets(`test-${Math.random()}`);
    store.write(resolveTargets(WITH_MIRROR));

    store.markWrite({ ok: false, reason: "HTTP 502" }, 0); // the instance refuses
    store.markWrite({ ok: true }, 1); // mirror accepts

    const t = store.read();
    expect(t?.stores?.[0]?.lastWriteMs).toBe(0);
    expect(t?.stores?.[0]?.lastFailureMs).toBeGreaterThan(0);
    expect(t?.stores?.[0]?.lastError).toBe("HTTP 502");
    expect(t?.stores?.[1]?.lastWriteMs).toBeGreaterThan(0);
    // The flat pair aggregates: recorded somewhere counts as recorded.
    expect(t?.lastWriteMs).toBeGreaterThan(0);
    expect(t?.lastFailureMs).toBe(0);
    store.clear();
  });

  test("a success clears the reason the last failure gave", () => {
    const store = makeTargets(`test-${Math.random()}`);
    store.write(resolveTargets(WITH_MIRROR));
    store.markWrite({ ok: false, reason: "timeout" }, 0);
    store.markWrite({ ok: true }, 0);
    expect(store.read()?.stores?.[0]?.lastError).toBeUndefined();
    store.clear();
  });

  test("every store failing leaves the aggregate failing", () => {
    const store = makeTargets(`test-${Math.random()}`);
    store.write(resolveTargets(WITH_MIRROR));
    store.markWrite(false, 0);
    store.markWrite(false, 1);

    const t = store.read();
    expect(t?.lastFailureMs).toBeGreaterThan(0);
    expect(t?.lastWriteMs).toBe(0);
    store.clear();
  });

  test("a targets file from an older binary is annotated, not corrupted", () => {
    // Written by a version with no `stores` key, then continued after an upgrade —
    // the file outlives the binary because it is per-session in /tmp.
    const store = makeTargets(`test-${Math.random()}`);
    const old = resolveTargets(WITH_MIRROR);
    old.stores = undefined;
    store.write(old);

    store.markWrite(true, 0);
    const t = store.read();
    expect(t?.stores).toBeUndefined();
    expect(t?.lastWriteMs).toBeGreaterThan(0);
    store.clear();
  });
});

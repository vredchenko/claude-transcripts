/**
 * Per-store write health.
 *
 * A single outcome pair could not express "the primary is dead but the mirror is fine",
 * which is the ordinary state of a machine reporting into a shared instance. Collapsed,
 * the indicator was wrong whichever way it resolved: counting only the direct store
 * showed permanent failure on a box recording correctly, and counting any store showed
 * a confident green dot labelled with a host that had accepted nothing for weeks.
 */
import { describe, expect, test } from "bun:test";
import { type HookConfig, makeTargets, resolveTargets } from "./runtime";

const WITH_MIRROR = {
  couch: { url: "http://user:pw@couch.example:5984", databases: { sessions: "app-sessions" } },
  features: {},
  mirrors: [{ url: "https://logs.example.com" }],
} as unknown as HookConfig;

describe("resolveTargets stores", () => {
  test("direct store first, then mirrors in config order", () => {
    const t = resolveTargets(WITH_MIRROR);
    expect(t.stores?.map((s) => s.kind)).toEqual(["direct", "mirror"]);
    expect(t.stores?.[0]?.label).toBe("app-sessions@couch.example:5984");
    expect(t.stores?.[1]?.label).toBe("logs.example.com");
  });

  test("always seeds at least the direct store — an empty `stores` cannot arise here", () => {
    // A renderer has to decide what an empty array means, and the honest answer is
    // "we never produce one": every config has a direct store, because `couch` is the
    // one block that cannot be defaulted. Pinned because the statusline now relies on
    // it to tell "nothing tried yet" apart from "nothing to try".
    const noMirrors = {
      couch: { url: "http://c:5984", databases: { sessions: "s" } },
      features: {},
    } as unknown as HookConfig;
    expect(resolveTargets(noMirrors).stores).toHaveLength(1);
    expect(resolveTargets(noMirrors).stores?.[0]?.kind).toBe("direct");
  });

  test("labels carry no credentials", () => {
    const t = resolveTargets(WITH_MIRROR);
    for (const s of t.stores ?? []) {
      expect(s.label).not.toContain("pw");
      expect(s.label).not.toContain("user");
    }
  });
});

describe("markWrite", () => {
  test("a mirror's success does not mark the direct store healthy", () => {
    // The reason this is per-store at all. Collapsed into one pair, a healthy mirror
    // would render a confident "recording" labelled with the dead primary's host.
    const store = makeTargets(`test-${Math.random()}`);
    store.write(resolveTargets(WITH_MIRROR));

    store.markWrite(false, 0); // primary refuses
    store.markWrite(true, 1); // mirror accepts

    const t = store.read();
    expect(t?.stores?.[0]?.lastWriteMs).toBe(0);
    expect(t?.stores?.[0]?.lastFailureMs).toBeGreaterThan(0);
    expect(t?.stores?.[1]?.lastWriteMs).toBeGreaterThan(0);
    store.clear();
  });

  test("the flat pair aggregates: recorded somewhere counts as recorded", () => {
    const store = makeTargets(`test-${Math.random()}`);
    store.write(resolveTargets(WITH_MIRROR));
    store.markWrite(false, 0);
    store.markWrite(true, 1);

    const t = store.read();
    expect(t?.lastWriteMs).toBeGreaterThan(0);
    expect(t?.lastFailureMs).toBe(0);
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

  test("no seed → nothing to annotate, and no crash", () => {
    const store = makeTargets(`test-${Math.random()}`);
    expect(() => store.markWrite(true, 0)).not.toThrow();
    expect(store.read()).toBeNull();
  });
});
